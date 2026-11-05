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
	nearestRoom,
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
	// Night, physically: no daylight; the ceiling lights' glass glows instead.
	buildHouse(view, scene, mats, physical, physical && !!camera.night);

	// The everyday view draws the fixed room one-sided, as a few dozen meshes, not
	// hundreds, laid out in a lightmap; the physical reference keeps every part as it is.
	let lit: Lit | undefined;
	if (!physical) {
		oneSided(view.scene, (g) => view.own(g));
		const meshes = mergeStatic(view.scene, (g) => view.own(g));
		lit = {
			meshes,
			centres: roomCentres(scene),
			atlas: unwrap(
				meshes.map((m) => m.geometry),
				LIGHTMAP_TEXEL,
			),
		};
	}
	if (!physical) addLight(view);
	placeCamera(view, room, camera);
	return lit ?? { meshes: [], centres: new Map(), atlas: { width: 0, height: 0, charts: 0 } };
}

/** Where the builder puts what it makes: a scene, and a keeper of what to dispose.
 *  A ThreeView is one; the physics builds into a bare scene. */
export interface Stage {
	readonly scene: THREE.Scene;
	own<T extends { dispose(): void }>(resource: T): T;
}

/** What a mesh of the house is, for the physics (`userData.solid`): a part of a piece,
 *  or a room's surface of a kind. */
export type SolidTag =
	| { kind: 'part'; piece: string; part: string; room?: string }
	| {
			kind: 'wall' | 'floor' | 'ceiling' | 'coving' | 'skirting' | 'frame' | 'glass' | 'passage';
			room?: string;
	  };

/**
 * The house's meshes, as drawn: every room's shell and windows, the passages
 * between rooms, and every piece as its parts, in place. Each mesh says which room
 * it is in (`userData.room`, the room whose reflections it takes) and what it is
 * (`userData.solid`).
 */
export function buildHouse(
	stage: Stage,
	scene: HouseScene,
	mats: MaterialLibrary,
	physical: boolean,
	night: boolean,
): void {
	const tag = (from: number, room: string | undefined, solid: (o: THREE.Object3D) => SolidTag) => {
		const shared = scene.rooms.find((r) => r.name === room)?.reflections ?? room;
		for (const o of stage.scene.children.slice(from)) {
			o.userData['room'] = shared;
			// Lights are not solids.
			if (o instanceof THREE.Mesh) o.userData['solid'] = solid(o);
		}
	};
	for (const r of scene.rooms) {
		const from = stage.scene.children.length;
		addRoomShell(stage, mats, scene, r, physical, night);
		tag(from, r.name, (o) => ({ kind: shellKind(o), room: r.name }));
	}
	for (const p of passages(scene)) {
		const from = stage.scene.children.length;
		addPassage(stage, mats, scene, p);
		tag(from, p.room.name, () => ({ kind: 'passage', room: p.room.name }));
	}
	// Each piece as its parts, closed; a piece without parts is its box.
	for (const f of scene.furniture) {
		const parts = partsOf(f);
		const room = nearestRoom(scene.rooms, f.cx, f.cz);
		solidsOf(f).forEach((sol, k) => {
			const from = stage.scene.children.length;
			const geom = stage.own(partGeometry(parts[k], sol.hw, sol.y1 - sol.y0, sol.hd));
			// A sheet has two faces to see; a solid shows only its outside.
			const sheet = parts[k].shape === 'folds' || parts[k].shape === 'fronds';
			const side = sheet ? THREE.DoubleSide : THREE.FrontSide;
			const mesh = new THREE.Mesh(geom, mats.get(partMaterial(scene, f, parts[k]), side));
			mesh.position.set(sol.x, (sol.y0 + sol.y1) / 2, sol.z);
			mesh.rotation.y = sol.yaw;
			mesh.castShadow = mesh.receiveShadow = true;
			stage.scene.add(mesh);
			if (night && (parts[k].material ?? f.material) === LAMP_MATERIAL) addLampLight(stage, mesh);
			tag(from, room, () => ({ kind: 'part', piece: sol.piece, part: sol.part, room }));
		});
	}
}

/** A shell mesh's kind, from what made it (`userData.shell`). */
function shellKind(o: THREE.Object3D): Exclude<SolidTag['kind'], 'part' | 'passage'> {
	const k: unknown = o.userData['shell'];
	if (
		k === 'wall' ||
		k === 'floor' ||
		k === 'ceiling' ||
		k === 'coving' ||
		k === 'skirting' ||
		k === 'frame' ||
		k === 'glass'
	)
		return k;
	throw new Error(`a room's shell made a mesh it did not name: ${o.type}`);
}

/** Each room's middle, by its outline's bounds: where its reflections are seen from. */
function roomCentres(scene: HouseScene): Map<string, Pt> {
	const out = new Map<string, Pt>();
	for (const r of scene.rooms) {
		const b = bounds(roomPerimeter(r));
		if (r.name && b) out.set(r.name, { x: b.cx, z: b.cz });
	}
	return out;
}

function addRoomShell(
	view: Stage,
	mats: MaterialLibrary,
	scene: HouseScene,
	room: Room,
	physical: boolean,
	night: boolean,
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
			view.scene.add(
				shell(facing(wallPanel(view, s, len, p.a0, p.a1, p.yb, p.yt, wallMat), inward), 'wall'),
			);
		}
		for (const o of ops)
			if (o.glazing) addGlazing(view, mats, scene, s, len, o, o.glazing, inward, physical, night);
		if (room.coving)
			view.scene.add(
				shell(
					facing(coving(view, s, inward, neighbours(i), scene.height, room.coving, covingMat), [
						inward[0],
						-1,
						inward[1],
					]),
					'coving',
				),
			);
		if (room.skirting)
			for (const [a0, a1] of skirtingRuns(len, ops, scene.height))
				view.scene.add(
					shell(
						skirting(view, s, len, a0, a1, inward, neighbours(i), room.skirting, skirtingMat),
						'skirting',
					),
				);
	});
	const floor = mats.get(surfaceMaterial(scene, room, 'floor'), THREE.DoubleSide);
	const ceiling = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	view.scene.add(shell(facing(flat(view, pts, 0, floor), [0, 1, 0]), 'floor'));
	view.scene.add(shell(facing(flat(view, pts, scene.height, ceiling), [0, -1, 0]), 'ceiling'));
}

/** Names what a shell mesh is, for the physics (`buildHouse`'s `userData.solid`). */
function shell(mesh: THREE.Mesh, kind: string): THREE.Mesh {
	mesh.userData['shell'] = kind;
	return mesh;
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
function addPassage(view: Stage, mats: MaterialLibrary, scene: HouseScene, p: Passage): void {
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
	view: Stage,
	mats: MaterialLibrary,
	scene: HouseScene,
	s: WallSeg,
	len: number,
	o: WallOpening,
	g: Glazing,
	inward: [number, number],
	physical: boolean,
	night: boolean,
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
			// At night the pane is dark: only its black back stays.
			if (!night) view.scene.add(light);
			// The pane behind it, black: the light is all it sends in. Left open, a
			// path that passed the light went on to the sky, and the pane counted twice.
			const back = new THREE.Mesh(
				view.own(metricBox(p.a1 - p.a0, p.yt - p.yb, 0.006)),
				mats.get({ color: '#000000', roughness: 1 }, THREE.DoubleSide),
			);
			back.position.set(s.ax + dx * along, (p.yb + p.yt) / 2, s.az + dz * along);
			back.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
			view.scene.add(shell(back, 'glass'));
			continue;
		}
		const geom = view.own(metricBox(p.a1 - p.a0, p.yt - p.yb, frame ? 0.07 : 0.006));
		const mesh = new THREE.Mesh(geom, mats.get(spec(key), THREE.DoubleSide));
		mesh.position.set(s.ax + dx * along, (p.yb + p.yt) / 2, s.az + dz * along);
		mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
		mesh.castShadow = frame;
		mesh.receiveShadow = true;
		view.scene.add(shell(mesh, frame ? 'frame' : 'glass'));
	}
}

/** The material of the glass a ceiling light shines through, at night. */
const LAMP_MATERIAL = 'lamp-shade';
/** A lit bulb behind frosted glass, warm white (2700 K, linear): the brightness is
 *  the exposure's to set, as a camera does, so any unit serves. */
const LAMP: [number, number, number] = [1, 0.4, 0.095];
const LAMP_RADIANCE = 100;

/** A lit lamp's glass as the light it sends out: an even emitter on each face of
 *  its box but the top (it is flush with the ceiling), facing out, so a path tracer
 *  can aim at it as at a frosted pane. */
function addLampLight(view: Stage, glass: THREE.Mesh): void {
	glass.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(glass);
	const [c, size] = [box.getCenter(new THREE.Vector3()), box.getSize(new THREE.Vector3())];
	const colour = new THREE.Color(...LAMP);
	const out = 0.002;
	const bottom = new THREE.RectAreaLight(colour, LAMP_RADIANCE, size.x, size.z);
	bottom.position.set(c.x, box.min.y - out, c.z);
	bottom.rotation.x = -Math.PI / 2; // facing straight down
	view.scene.add(bottom);
	for (const [dx, dz] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const) {
		const across = dx ? size.z : size.x;
		const side = new THREE.RectAreaLight(colour, LAMP_RADIANCE, across, size.y);
		const x = c.x + dx * (size.x / 2 + out);
		const z = c.z + dz * (size.z / 2 + out);
		side.position.set(x, c.y, z);
		side.lookAt(x + dx, c.y, z + dz);
		view.scene.add(side);
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
		case 'fronds':
			return fronds(hw * 2, h, hd * 2);
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

const FROND_LEAVES = 34;
/** Metres across a crown's stem. */
const FROND_STEM = 0.025;
const FROND_STEPS = 6;

/** A crown of long leaves, as a dracaena's: from one point they spread round by the
 *  golden angle, the inner ones upright, the outer ones lower and drooping at their
 *  tips, each a strip widest at its middle; scaled to fill the box, on a stem from
 *  the box's foot to that point. */
function fronds(w: number, h: number, d: number): THREE.BufferGeometry {
	const pos: number[] = [];
	for (let k = 0; k < FROND_LEAVES; k++) {
		const phi = k * 2.39996;
		const f = k / (FROND_LEAVES - 1);
		const rise = ((80 - 70 * f) * Math.PI) / 180;
		const length = 0.6 + 0.4 * f;
		const droop = 0.25 + 0.6 * f;
		const [dx, dz] = [Math.cos(phi), Math.sin(phi)];
		for (let i = 0; i <= FROND_STEPS; i++) {
			const t = i / FROND_STEPS;
			const out = length * t * Math.cos(rise);
			const y = length * t * Math.sin(rise) - droop * length * t * t;
			const half = 0.07 * length * Math.pow(Math.sin(Math.PI * t), 0.8);
			pos.push(out * dx + half * dz, y, out * dz - half * dx);
			pos.push(out * dx - half * dz, y, out * dz + half * dx);
		}
	}
	const xs = pos.filter((_, i) => i % 3 === 0);
	const ys = pos.filter((_, i) => i % 3 === 1);
	const zs = pos.filter((_, i) => i % 3 === 2);
	const [sx, sz] = [Math.max(...xs.map(Math.abs)), Math.max(...zs.map(Math.abs))];
	const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
	for (let i = 0; i < pos.length; i += 3) {
		pos[i] = (pos[i] / sx) * (w / 2);
		pos[i + 1] = ((pos[i + 1] - y0) / (y1 - y0) - 0.5) * h;
		pos[i + 2] = (pos[i + 2] / sz) * (d / 2);
	}
	const index: number[] = [];
	const row = 2 * (FROND_STEPS + 1);
	for (let k = 0; k < FROND_LEAVES; k++)
		for (let i = 0; i < FROND_STEPS; i++) {
			const a = k * row + 2 * i;
			index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
		}
	// The stem: two crossed strips up to where the leaves spread.
	const top = (-y0 / (y1 - y0) - 0.5) * h;
	const r = FROND_STEM / 2;
	for (const [ax, az] of [
		[r, 0],
		[0, r],
	]) {
		const a = pos.length / 3;
		pos.push(-ax, -h / 2, -az, ax, -h / 2, az, -ax, top, -az, ax, top, az);
		index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
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
	view: Stage,
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
	view: Stage,
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
	/** Each room's middle, by name: its meshes carry `userData.room`. */
	centres: Map<string, Pt>;
	atlas: Atlas;
}

/** Glass this smooth transmits without scattering: a window to see the sky through. */
const CLEAR_GLASS_ROUGHNESS = 0.1;

/** One solid slab of a wall, with UVs in metres so a texture keeps its scale. */
function wallPanel(
	view: Stage,
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
function flat(view: Stage, pts: Pt[], y: number, mat: THREE.Material): THREE.Mesh {
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
 *  carpet is the same size on a shelf as on a door. The grain (u) runs along
 *  each face's longer side: up a door, along a shelf. */
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
			const [u, v] = [uv.getX(i) * su, uv.getY(i) * sv];
			if (sv > su) uv.setXY(i, v, u);
			else uv.setXY(i, u, v);
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
