import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraQuery } from './camera';
import type { Glazing, HouseScene, Part, Room, WallOpening } from './house.model';
import { partsOf, solidsOf } from './assembly';
import { MaterialLibrary, partMaterial, surfaceMaterial } from './materials';
import { mergeStatic } from './merge';
import { oneSided } from './sides';
import { unwrap } from './unwrap';
import type { Atlas } from './unwrap';
import {
	bounds,
	covingProfile,
	glazingLayout,
	inwardNormals,
	mitre,
	passages,
	roomPerimeter,
	segments,
	skirtingRuns,
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
): Lit | undefined {
	const room = scene.rooms.find((r) => r.name === roomName);
	if (!room) return undefined;
	const mats = new MaterialLibrary(<T extends { dispose(): void }>(r: T) => view.own(r));

	for (const r of scene.rooms) addRoomShell(view, mats, scene, r, physical);
	for (const p of passages(scene)) addPassage(view, mats, scene, p);
	// Each piece as its parts, closed; a piece without parts is its box.
	for (const f of scene.furniture) {
		const parts = partsOf(f);
		solidsOf(f).forEach((sol, k) => {
			const geom = view.own(partGeometry(parts[k], sol.hw, sol.y1 - sol.y0, sol.hd));
			// A sheet has two faces to see; a solid shows only its outside.
			const side = parts[k].shape === 'folds' ? THREE.DoubleSide : THREE.FrontSide;
			const mesh = new THREE.Mesh(geom, mats.get(partMaterial(scene, f, parts[k]), side));
			mesh.position.set(sol.x, (sol.y0 + sol.y1) / 2, sol.z);
			mesh.rotation.y = sol.yaw;
			mesh.castShadow = mesh.receiveShadow = true;
			view.scene.add(mesh);
		});
	}

	// The everyday view draws the fixed room one-sided, as a few dozen meshes, not
	// hundreds, laid out in a lightmap; the physical reference keeps every part as it is.
	let lit: Lit | undefined;
	if (!physical) {
		oneSided(view.scene, (g) => view.own(g));
		const meshes = mergeStatic(view.scene, (g) => view.own(g));
		lit = {
			meshes,
			atlas: unwrap(
				meshes.map((m) => m.geometry),
				LIGHTMAP_TEXEL,
			),
		};
	}
	if (!physical) addLight(view);
	placeCamera(view, room, camera);
	return lit ?? { meshes: [], atlas: { width: 0, height: 0, charts: 0 } };
}

function addRoomShell(
	view: ThreeView,
	mats: MaterialLibrary,
	scene: HouseScene,
	room: Room,
	physical: boolean,
): void {
	const pts = roomPerimeter(room);
	const into = inwardNormals(pts);
	const wallMat = mats.get(surfaceMaterial(scene, room, 'walls'), THREE.DoubleSide);
	const covingMat = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	const skirtingMat = mats.get(surfaceMaterial(scene, room, 'skirting'));
	const segs = segments(pts);
	// The inward normals of the walls before and after wall i, round the outline,
	// skipping any of no length.
	const real = segs.map((s) => Math.hypot(s.bx - s.ax, s.bz - s.az) > 1e-6);
	const step = (i: number, by: number) => {
		let j = i;
		do j = (j + by + segs.length) % segs.length;
		while (!real[j] && j !== i);
		return into[j];
	};
	const neighbours = (i: number): [[number, number], [number, number]] => [step(i, -1), step(i, 1)];
	segs.forEach((s, i) => {
		const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
		if (len < 1e-6) return;
		const ops = (room.openings ?? []).filter((o) => o.wall === i);
		const inward = into[i];
		for (const p of wallPanels(len, ops, scene.height)) {
			view.scene.add(facing(wallPanel(view, s, len, p.a0, p.a1, p.yb, p.yt, wallMat), inward));
		}
		for (const o of ops)
			if (o.glazing) addGlazing(view, mats, scene, s, len, o, o.glazing, inward, physical);
		if (room.coving)
			view.scene.add(
				facing(coving(view, s, inward, neighbours(i), scene.height, room.coving, covingMat), [
					inward[0],
					-1,
					inward[1],
				]),
			);
		if (room.skirting)
			for (const [a0, a1] of skirtingRuns(len, ops, scene.height))
				view.scene.add(
					skirting(view, s, len, a0, a1, inward, neighbours(i), room.skirting, skirtingMat),
				);
	});
	const floor = mats.get(surfaceMaterial(scene, room, 'floor'), THREE.DoubleSide);
	const ceiling = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	view.scene.add(facing(flat(view, pts, 0, floor), [0, 1, 0]));
	view.scene.add(facing(flat(view, pts, scene.height, ceiling), [0, -1, 0]));
}

/** Marks which way a surface faces into its room, [x, z] or [x, y, z]: the lightmap
 *  view draws it from that side only (`sides.ts`). */
function facing(mesh: THREE.Mesh, dir: [number, number] | [number, number, number]): THREE.Mesh {
	const [x, y, z] = dir.length === 2 ? [dir[0], 0, dir[1]] : dir;
	mesh.userData['facing'] = new THREE.Vector3(x, y, z).normalize();
	return mesh;
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

/** Sides for a round shape of this radius: one about every 3 cm of its rim, 8
 *  for a button, 48 at most. Finer is invisible, and each side is vertices the
 *  phone draws and the bake lights. */
function around(radius: number): number {
	return Math.max(8, Math.min(48, Math.round((2 * Math.PI * radius) / 0.03)));
}

/** A part's shape, centred on its box (half-width, height, half-depth). */
function partGeometry(part: Part, hw: number, h: number, hd: number): THREE.BufferGeometry {
	switch (part.shape) {
		case 'cylinder':
			return new THREE.CylinderGeometry(hw, hw, hd * 2, around(hw)).rotateX(Math.PI / 2);
		case 'dome':
			// The upper half of a unit sphere, stretched to the box, its base at the box's foot.
			return new THREE.SphereGeometry(
				1,
				around(Math.max(hw, hd)),
				12,
				0,
				Math.PI * 2,
				0,
				Math.PI / 2,
			)
				.scale(hw, h, hd)
				.translate(0, -h / 2, 0);
		case 'folds':
			return folds(hw * 2, h, hd * 2);
		case 'arch':
			return arch(hw * 2, h, hd * 2, part.rise);
		case 'roll':
			return new THREE.CylinderGeometry(1, 1, hw * 2, around(Math.max(h / 2, hd)))
				.rotateZ(Math.PI / 2)
				.scale(1, h / 2, hd);
		case 'bowl':
			// The lower half of a unit sphere, stretched to the box, its flat top at the box's top.
			return new THREE.SphereGeometry(
				1,
				around(Math.max(hw, hd)),
				8,
				0,
				Math.PI * 2,
				Math.PI / 2,
				Math.PI / 2,
			)
				.scale(hw, h, hd)
				.translate(0, h / 2, 0);
		case 'disc':
			return new THREE.CylinderGeometry(1, 1, h, around(Math.max(hw, hd))).scale(hw, 1, hd);
		case 'cushion': {
			// Rounded as soft upholstery is: a third of its thinnest side, at most 6 cm.
			const r = Math.min(0.06, Math.min(hw * 2, h, hd * 2) / 3);
			return new RoundedBoxGeometry(hw * 2, h, hd * 2, 2, r);
		}
		case 'ring': {
			const tube = hd;
			return new THREE.TorusGeometry(Math.max(hw - tube, tube), tube, 16, 48).scale(
				1,
				h / (hw * 2),
				1,
			);
		}
		case 'lathe': {
			if (!part.profile || part.profile.length < 2)
				throw new Error(`part ${part.id} is a lathe without a profile`);
			const pts = part.profile.map(([r, y]) => new THREE.Vector2(r, y - 0.5));
			return new THREE.LatheGeometry(pts, around(Math.max(hw, hd))).scale(hw, h, hd);
		}
		default:
			return metricBox(hw * 2, h, hd * 2);
	}
}

/** A slab `w` wide, `h` tall and `d` deep whose top arches `rise` above its
 *  shoulders (a half circle across its width when absent), centred. */
function arch(w: number, h: number, d: number, rise = w / 2): THREE.BufferGeometry {
	const half = w / 2;
	const up = Math.min(rise, h);
	// The circle through both shoulders and the crown.
	const r = (up * up + half * half) / (2 * up);
	const shoulder = h / 2 - up;
	const centre = shoulder - (r - up);
	const a = Math.atan2(shoulder - centre, half);
	const outline = new THREE.Shape();
	outline.moveTo(-half, -h / 2);
	outline.lineTo(half, -h / 2);
	outline.lineTo(half, shoulder);
	outline.absarc(0, centre, r, a, Math.PI - a, false);
	outline.lineTo(-half, -h / 2);
	return new THREE.ExtrudeGeometry(outline, {
		depth: d,
		bevelEnabled: false,
		curveSegments: 32,
	}).translate(0, 0, -d / 2);
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
	[before, after]: [[number, number], [number, number]],
	height: number,
	c: { drop: number; depth: number },
	mat: THREE.Material,
): THREE.Mesh {
	const prof = covingProfile(c.drop, c.depth);
	const pos: number[] = [];
	// Each end cut to meet the next wall's coving, as a mitred moulding is.
	for (const [u, v] of prof) {
		const a = mitre({ x: s.ax, z: s.az }, inward, before, u);
		const b = mitre({ x: s.bx, z: s.bz }, inward, after, u);
		pos.push(a.x, height - v, a.z, b.x, height - v, b.z);
	}
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

/** One run of skirting, `a0` to `a1` along the wall: a board `height` tall and
 *  `depth` out from it. Where the run reaches a corner its end is mitred to meet
 *  the next wall's, as a moulding is cut; where it stops at a doorway it ends
 *  square, closed. */
function skirting(
	view: ThreeView,
	s: WallSeg,
	len: number,
	a0: number,
	a1: number,
	inward: [number, number],
	[before, after]: [[number, number], [number, number]],
	k: { height: number; depth: number },
	mat: THREE.Material,
): THREE.Mesh {
	const [dx, dz] = [(s.bx - s.ax) / len, (s.bz - s.az) / len];
	const atWall = (a: number) => ({ x: s.ax + dx * a, z: s.az + dz * a });
	const cornerAtStart = a0 < 1e-6;
	const cornerAtEnd = a1 > len - 1e-6;
	// The board's two ends, `u` out from the wall.
	const start = (u: number) =>
		cornerAtStart
			? mitre(atWall(0), inward, before, u)
			: { x: atWall(a0).x + inward[0] * u, z: atWall(a0).z + inward[1] * u };
	const end = (u: number) =>
		cornerAtEnd
			? mitre(atWall(len), inward, after, u)
			: { x: atWall(a1).x + inward[0] * u, z: atWall(a1).z + inward[1] * u };
	const pos: number[] = [];
	const uv: number[] = [];
	const v3 = (p: { x: number; z: number }, y: number) => new THREE.Vector3(p.x, y, p.z);
	// A quad, wound to face `want`: two triangles.
	const quad = (q: THREE.Vector3[], want: THREE.Vector3) => {
		const n = new THREE.Vector3()
			.subVectors(q[1], q[0])
			.cross(new THREE.Vector3().subVectors(q[2], q[0]));
		const order = n.dot(want) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
		for (const i of order) {
			pos.push(q[i].x, q[i].y, q[i].z);
			uv.push(q[i].x + q[i].z, q[i].y);
		}
	};
	const out = new THREE.Vector3(inward[0], 0, inward[1]);
	const [h, d] = [k.height, k.depth];
	quad([v3(start(d), 0), v3(end(d), 0), v3(end(d), h), v3(start(d), h)], out);
	quad(
		[v3(start(0), h), v3(end(0), h), v3(end(d), h), v3(start(d), h)],
		new THREE.Vector3(0, 1, 0),
	);
	const along = new THREE.Vector3(dx, 0, dz);
	if (!cornerAtStart)
		quad(
			[v3(start(0), 0), v3(start(d), 0), v3(start(d), h), v3(start(0), h)],
			along.clone().negate(),
		);
	if (!cornerAtEnd) quad([v3(end(0), 0), v3(end(d), 0), v3(end(d), h), v3(end(0), h)], along);
	const geom = view.own(new THREE.BufferGeometry());
	geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	geom.computeVertexNormals();
	const mesh = new THREE.Mesh(geom, mat);
	mesh.castShadow = mesh.receiveShadow = true;
	return mesh;
}

/** The lightmap's resolution, metres a pixel: fine enough for the shadow line where
 *  a shelf meets a wall. */
const LIGHTMAP_TEXEL = 0.02;

/** The everyday view's fixed room, merged, and where each surface's light is in
 *  the lightmap (its geometries' `uv1`). */
export interface Lit {
	meshes: THREE.Mesh[];
	atlas: Atlas;
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
