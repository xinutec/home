import * as THREE from 'three';
import type { CameraQuery } from './camera';
import type { Glazing, HouseScene, Part, Room, WallOpening } from './house.model';
import { partsOf, solidsOf } from './assembly';
import { MaterialLibrary, partMaterial, surfaceMaterial } from './materials';
import {
	bounds,
	covingProfile,
	glazingLayout,
	passages,
	roomPerimeter,
	segments,
	wallPanels,
} from './scene-geometry';
import type { P3, Passage } from './scene-geometry';
import type { Pt, WallSeg } from './scene-geometry';
import { SKY, windowRadiance } from './sky';
import type { ThreeView } from './three-view';

/**
 * The house as seen from inside one room: opaque walls, floor and ceiling in
 * each room's materials, furniture in its own, a sun through the windows with
 * soft shadows, and the camera at the room's `view`.
 *
 * Every room is drawn, not only the one named: the bay and the dining room are
 * seen through their openings.
 */
export function buildInterior(
	view: ThreeView,
	scene: HouseScene,
	roomName: string,
	camera: CameraQuery = {},
	/** Light only from the world outside (the path-traced reference), not the approximations. */
	physical = false,
): boolean {
	const room = scene.rooms.find((r) => r.name === roomName);
	if (!room) return false;
	const mats = new MaterialLibrary(<T extends { dispose(): void }>(r: T) => view.own(r));

	for (const r of scene.rooms) addRoomShell(view, mats, scene, r, physical);
	for (const p of passages(scene)) addPassage(view, mats, scene, p);
	// Each piece as its parts, closed; a piece without parts is its box.
	for (const f of scene.furniture) {
		const parts = partsOf(f);
		solidsOf(f).forEach((sol, k) => {
			const geom = view.own(partGeometry(parts[k].shape, sol.hw, sol.y1 - sol.y0, sol.hd));
			// A sheet has two faces to see; a solid shows only its outside.
			const side = parts[k].shape === 'folds' ? THREE.DoubleSide : THREE.FrontSide;
			const mesh = new THREE.Mesh(geom, mats.get(partMaterial(scene, f, parts[k]), side));
			mesh.position.set(sol.x, (sol.y0 + sol.y1) / 2, sol.z);
			mesh.rotation.y = sol.yaw;
			mesh.castShadow = mesh.receiveShadow = true;
			view.scene.add(mesh);
		});
	}

	if (!physical) addLight(view);
	placeCamera(view, room, camera);
	return true;
}

function addRoomShell(
	view: ThreeView,
	mats: MaterialLibrary,
	scene: HouseScene,
	room: Room,
	physical: boolean,
): void {
	const pts = roomPerimeter(room);
	const centre = bounds(pts);
	const wallMat = mats.get(surfaceMaterial(scene, room, 'walls'), THREE.DoubleSide);
	const covingMat = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	segments(pts).forEach((s, i) => {
		const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
		if (len < 1e-6) return;
		const ops = (room.openings ?? []).filter((o) => o.wall === i);
		for (const p of wallPanels(len, ops, scene.height)) {
			view.scene.add(wallPanel(view, s, len, p.a0, p.a1, p.yb, p.yt, wallMat));
		}
		// Into the room: the side of the wall facing its centre (every room here is convex).
		const nx = -(s.bz - s.az) / len;
		const nz = (s.bx - s.ax) / len;
		const toCentre = centre
			? (centre.cx - (s.ax + s.bx) / 2) * nx + (centre.cz - (s.az + s.bz) / 2) * nz
			: 1;
		const inward: [number, number] = toCentre >= 0 ? [nx, nz] : [-nx, -nz];
		for (const o of ops)
			if (o.glazing) addGlazing(view, mats, scene, s, len, o, o.glazing, inward, physical);
		if (room.coving) view.scene.add(coving(view, s, inward, scene.height, room.coving, covingMat));
	});
	view.scene.add(
		flat(view, pts, 0, mats.get(surfaceMaterial(scene, room, 'floor'), THREE.DoubleSide)),
	);
	view.scene.add(
		flat(
			view,
			pts,
			scene.height,
			mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide),
		),
	);
}

/** The wall's thickness at a doorway: floor, soffit and jambs between the two
 *  rooms' openings. */
function addPassage(view: ThreeView, mats: MaterialLibrary, scene: HouseScene, p: Passage): void {
	const wall = mats.get(surfaceMaterial(scene, p.room, 'walls'), THREE.DoubleSide);
	const floor = mats.get(surfaceMaterial(scene, p.room, 'floor'), THREE.DoubleSide);
	for (const [quad, mat] of [
		[p.floor, floor],
		[p.soffit, wall],
		...p.jambs.map((j) => [j, wall] as const),
	] as const) {
		const mesh = new THREE.Mesh(view.own(quadGeometry(quad)), mat);
		mesh.receiveShadow = true;
		mesh.castShadow = true;
		view.scene.add(mesh);
	}
}

/** Four corners in order as two triangles, UVs the x, z in metres (so a carpet tiles). */
function quadGeometry(q: P3[]): THREE.BufferGeometry {
	const g = new THREE.BufferGeometry();
	const pos = [q[0], q[1], q[2], q[0], q[2], q[3]].flat();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	const uv = [q[0], q[1], q[2], q[0], q[2], q[3]].flatMap(([x, , z]) => [x, z]);
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.computeVertexNormals();
	return g;
}

/** A window in its opening: frame bars 7 cm deep, panes of 6 mm glass, on the
 *  wall's line. Glass lets the sun through, so it casts no shadow. */
function addGlazing(
	view: ThreeView,
	mats: MaterialLibrary,
	scene: HouseScene,
	s: WallSeg,
	len: number,
	o: WallOpening,
	g: Glazing,
	inward: [number, number],
	physical: boolean,
): void {
	const spec = (key: string) => {
		const m = scene.materials?.[key];
		if (!m) throw new Error(`the scene's materials have no "${key}"`);
		return m;
	};
	const dx = (s.bx - s.ax) / len;
	const dz = (s.bz - s.az) / len;
	for (const p of glazingLayout(o, g)) {
		const frame = p.kind === 'frame';
		const along = (p.a0 + p.a1) / 2;
		const key = frame ? g.frameMaterial : p.kind === 'lower' ? g.lower : (g.upper ?? g.lower);
		// Clear glass is drawn as glass, and the tracer sees the sky through it, so its
		// light keeps its direction: down from the sky, up only from the ground.
		const clear = (spec(key).roughness ?? 1) <= CLEAR_GLASS_ROUGHNESS;
		if (physical && !frame && !clear) {
			// A diffusing pane as the light it lets in: an even emitter facing the room,
			// which a path tracer can aim at, as frosted glass sends light every way.
			const light = new THREE.RectAreaLight(
				new THREE.Color(...SKY),
				windowRadiance(spec(key).transmission ?? 1),
				p.a1 - p.a0,
				p.yt - p.yb,
			);
			const x = s.ax + dx * along + inward[0] * 0.004;
			const z = s.az + dz * along + inward[1] * 0.004;
			light.position.set(x, (p.yb + p.yt) / 2, z);
			light.lookAt(x + inward[0], (p.yb + p.yt) / 2, z + inward[1]);
			view.scene.add(light);
			continue;
		}
		const geom = view.own(metricBox(p.a1 - p.a0, p.yt - p.yb, frame ? 0.07 : 0.006));
		const mesh = new THREE.Mesh(geom, mats.get(spec(key), THREE.DoubleSide));
		mesh.position.set(s.ax + dx * along, (p.yb + p.yt) / 2, s.az + dz * along);
		mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
		mesh.castShadow = frame;
		mesh.receiveShadow = true;
		view.scene.add(mesh);
	}
}

/** A part's shape, centred on its box (half-width, height, half-depth). */
function partGeometry(
	shape: Part['shape'],
	hw: number,
	h: number,
	hd: number,
): THREE.BufferGeometry {
	switch (shape) {
		case 'cylinder':
			return new THREE.CylinderGeometry(hw, hw, hd * 2, 32).rotateX(Math.PI / 2);
		case 'dome':
			// The upper half of a unit sphere, stretched to the box, its base at the box's foot.
			return new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2)
				.scale(hw, h, hd)
				.translate(0, -h / 2, 0);
		case 'folds':
			return folds(hw * 2, h, hd * 2);
		default:
			return metricBox(hw * 2, h, hd * 2);
	}
}

/** Pleats a curtain bunches into: one about every FOLD_PITCH metres across. */
const FOLD_PITCH = 0.055;

/** A sheet `w` wide and `h` tall, rippled `d` deep across its width, centred. */
function folds(w: number, h: number, d: number): THREE.BufferGeometry {
	const n = Math.max(1, Math.round(w / FOLD_PITCH));
	const steps = n * 12;
	const pos: number[] = [];
	for (let i = 0; i <= steps; i++) {
		const x = -w / 2 + (w * i) / steps;
		const z = (d / 2) * Math.sin((2 * Math.PI * n * i) / steps);
		pos.push(x, -h / 2, z, x, h / 2, z);
	}
	const index: number[] = [];
	for (let i = 0; i < steps; i++) {
		const [a, b, c, e] = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3];
		index.push(a, c, b, b, c, e);
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geom.setIndex(index);
	geom.computeVertexNormals();
	return geom;
}

/** A wall's coving: its profile swept along the wall's top, into the room. Strips
 *  meet at the corners by overlapping, which the eye does not see. */
function coving(
	view: ThreeView,
	s: WallSeg,
	inward: [number, number],
	height: number,
	c: { drop: number; depth: number },
	mat: THREE.Material,
): THREE.Mesh {
	const prof = covingProfile(c.drop, c.depth);
	const pos: number[] = [];
	for (const [u, v] of prof)
		for (const [x, z] of [
			[s.ax, s.az],
			[s.bx, s.bz],
		])
			pos.push(x + inward[0] * u, height - v, z + inward[1] * u);
	const index: number[] = [];
	for (let k = 0; k < prof.length - 1; k++) {
		const [a, b, c2, d] = [2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3];
		index.push(a, b, c2, b, d, c2);
	}
	const geom = view.own(new THREE.BufferGeometry());
	geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geom.setIndex(index);
	geom.computeVertexNormals();
	const mesh = new THREE.Mesh(geom, mat);
	mesh.castShadow = mesh.receiveShadow = true;
	return mesh;
}

/** Glass this smooth transmits without scattering: a window to see the sky through. */
const CLEAR_GLASS_ROUGHNESS = 0.1;

/** One solid slab of a wall, with UVs in metres so a texture keeps its scale. */
function wallPanel(
	view: ThreeView,
	s: WallSeg,
	len: number,
	a0: number,
	a1: number,
	yb: number,
	yt: number,
	mat: THREE.Material,
): THREE.Mesh {
	const geom = view.own(new THREE.PlaneGeometry(a1 - a0, yt - yb));
	scaleUv(geom, a1 - a0, yt - yb);
	const dx = (s.bx - s.ax) / len;
	const dz = (s.bz - s.az) / len;
	const along = (a0 + a1) / 2;
	const mesh = new THREE.Mesh(geom, mat);
	mesh.position.set(s.ax + dx * along, (yb + yt) / 2, s.az + dz * along);
	mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
	mesh.castShadow = mesh.receiveShadow = true;
	return mesh;
}

/** The room's outline as a horizontal surface at height `y`: its floor or ceiling.
 *  ShapeGeometry's UVs are the outline's coordinates, so already in metres. */
function flat(view: ThreeView, pts: Pt[], y: number, mat: THREE.Material): THREE.Mesh {
	const shape = new THREE.Shape();
	shape.moveTo(pts[0].x, pts[0].z);
	for (const p of pts.slice(1)) shape.lineTo(p.x, p.z);
	const geom = view.own(new THREE.ShapeGeometry(shape));
	geom.rotateX(Math.PI / 2); // XY shape → XZ plane
	const mesh = new THREE.Mesh(geom, mat);
	mesh.position.y = y;
	mesh.receiveShadow = true;
	mesh.castShadow = y > 0; // the ceiling shades what is under it
	return mesh;
}

/** A box whose UVs run in metres on every face, not 0..1, so wood grain or
 *  carpet is the same size on a shelf as on a door. */
export function metricBox(w: number, h: number, d: number): THREE.BoxGeometry {
	const geom = new THREE.BoxGeometry(w, h, d);
	const uv = uvOf(geom);
	// Face order is +x, -x, +y, -y, +z, -z, four vertices each; [u span, v span].
	const spans: [number, number][] = [
		[d, h],
		[d, h],
		[w, d],
		[w, d],
		[w, h],
		[w, h],
	];
	spans.forEach(([su, sv], face) => {
		for (let k = 0; k < 4; k++) {
			const i = face * 4 + k;
			uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
		}
	});
	uv.needsUpdate = true;
	return geom;
}

function scaleUv(geom: THREE.BufferGeometry, su: number, sv: number): void {
	const uv = uvOf(geom);
	for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
	uv.needsUpdate = true;
}

/** A soft overcast sky, and a low sun from outside the bay casting soft shadows. */
function addLight(view: ThreeView): void {
	view.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a5550, 0.35));
	const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
	sun.position.set(9, 4.5, 2.6);
	sun.target.position.set(0, 0, 1.4);
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	const cam = sun.shadow.camera;
	cam.left = cam.bottom = -7;
	cam.right = cam.top = 7;
	cam.near = 1;
	cam.far = 25;
	sun.shadow.bias = -0.0004;
	sun.shadow.normalBias = 0.02;
	view.scene.add(sun, sun.target);
}

/** Standing where the room's `view` says, looking where it says; orbiting turns
 *  the head rather than swinging round a far point, so it stays in the room. */
function placeCamera(view: ThreeView, room: Room, asked: CameraQuery): void {
	const b = bounds(roomPerimeter(room));
	const eye = new THREE.Vector3(...(asked.eye ?? room.view?.eye ?? [b?.cx ?? 0, 1.55, b?.cz ?? 0]));
	const look = new THREE.Vector3(
		...(asked.look ?? room.view?.look ?? [b?.cx ?? 0, 1.2, (b?.cz ?? 0) - 1]),
	);
	const dir = look.clone().sub(eye).normalize();
	view.camera.fov = asked.fov ?? 60;
	view.camera.position.copy(eye);
	view.controls.target.copy(eye.clone().addScaledVector(dir, 0.6));
	view.controls.minDistance = 0.1;
	view.controls.maxDistance = 1.5;
	view.camera.updateProjectionMatrix();
	view.controls.update();
}

/** The geometry's UVs. Every geometry here builds its own, never interleaved. */
function uvOf(geom: THREE.BufferGeometry): THREE.BufferAttribute {
	const uv = geom.getAttribute('uv');
	if (!(uv instanceof THREE.BufferAttribute)) throw new Error('geometry without plain UVs');
	return uv;
}
