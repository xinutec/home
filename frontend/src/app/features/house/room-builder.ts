import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraQuery } from './camera';
import type { Furniture, Glazing, HouseScene, Part, Room, WallOpening } from './house.model';
import { partsOf, pieceId, solidsOf } from './assembly';
import type { JointState } from './assembly';
import { MaterialLibrary, named, partMaterial, surfaceMaterial } from './materials';
import { mergeStatic } from './merge';
import { oneSided } from './sides';
import { unwrap } from './unwrap';
import type { Atlas, Layout } from './unwrap';
import type { Surfaces } from './edits';
import {
	bounds,
	covingProfile,
	glazingLayout,
	inwardNormals,
	mitre,
	passages,
	nearestRoom,
	revealQuads,
	roomPerimeter,
	roomSkirting,
	segments,
	wallPanels,
	wells,
	holds,
} from './scene-geometry';
import type { P3, Passage, Well } from './scene-geometry';
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
	/** The last bake's atlas layout, which every chart it has keeps (`unwrap`). */
	layout?: Layout,
): Lit | undefined {
	const room = scene.rooms.find((r) => r.name === roomName);
	if (!room) return undefined;
	const mats = new MaterialLibrary(
		<T extends { dispose(): void }>(r: T) => view.own(r),
		true,
		() => view.requestFrame(),
	);
	// Night, physically: no daylight; the ceiling lights' glass glows instead.
	buildHouse(view, scene, mats, physical, physical && !!camera.night);

	// The everyday view draws the fixed room one-sided, as a few dozen meshes, not
	// hundreds, laid out in a lightmap; the physical reference keeps every part as it is.
	const lit = physical ? undefined : litRoom(view, scene, layout);
	if (!physical) addLight(view);
	placeCamera(view, room, camera);
	return (
		lit ?? {
			meshes: [],
			movables: [],
			centres: new Map(),
			atlas: {
				width: 0,
				height: 0,
				charts: 0,
				layout: new Map(),
				added: [],
				removed: [],
				fresh: [],
			},
		}
	);
}

/** The surfaces of `meshes` as the bake sees them, where they stand: each triangle,
 *  and a hash of what it is made of (`madeOf`). */
export function surfacesOf(meshes: THREE.Mesh[]): Surfaces {
	const tris: number[] = [];
	const salts: number[] = [];
	for (const m of meshes) {
		m.updateMatrixWorld();
		const p = m.geometry.getAttribute('position').clone().applyMatrix4(m.matrixWorld);
		let h = 0x811c9dc5;
		for (const c of madeOf(m)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
		for (let i = 0; i < p.count; i++) tris.push(p.getX(i), p.getY(i), p.getZ(i));
		for (let t = 0; t < p.count / 3; t++) salts.push(h >>> 0);
	}
	return { tris: Float32Array.from(tris), salts: Uint32Array.from(salts) };
}

/** What a mesh is made of, as the bake sees it: its colour, roughness, how much
 *  light it lets through, and how many sides it shows. Changed, its charts are new. */
/**
 * The house built into `stage` (`buildHouse`) made the room the lightmap lights:
 * drawn one-sided, merged into a few dozen meshes, laid out in its atlas (keeping
 * `layout`'s charts, the last bake's). What a bake is checked against
 * (`roomChecksum`): built so by the page, and by the check that the committed bake
 * still fits the scene.
 */
export function litRoom(
	stage: { scene: THREE.Scene; own: <T extends { dispose(): void }>(r: T) => T },
	scene: HouseScene,
	layout?: Layout,
): Lit {
	oneSided(stage.scene, (g) => stage.own(g));
	const meshes = mergeStatic(stage.scene, (g) => stage.own(g));
	return {
		meshes,
		movables: stage.scene.children.filter(
			(o): o is THREE.Mesh => o instanceof THREE.Mesh && o.userData['movable'] !== undefined,
		),
		centres: roomCentres(scene),
		atlas: unwrap(
			meshes.map((m) => m.geometry),
			LIGHTMAP_TEXEL,
			layout,
			meshes.map(madeOf),
		),
	};
}

function madeOf(m: THREE.Mesh): string {
	const mat = m.material;
	if (Array.isArray(mat)) return 'many';
	const std = mat instanceof THREE.MeshStandardMaterial ? mat : undefined;
	const through = mat instanceof THREE.MeshPhysicalMaterial ? mat.transmission : 0;
	return [std?.color.getHexString() ?? '-', std?.roughness ?? '-', through, mat.side].join('|');
}

/** Where the builder puts what it makes: a scene, and a keeper of what to dispose.
 *  A ThreeView is one; the physics builds into a bare scene. */
export interface Stage {
	readonly scene: THREE.Scene;
	own<T extends { dispose(): void }>(resource: T): T;
}

/** What a mesh of the house is, for the physics (`solidTag`): a part of a piece,
 *  or a room's surface of a kind. */
export type SolidTag =
	/** `sheet`: an open surface (a curtain's folds, leaves), with no inside. */
	| { kind: 'part'; piece: string; part: string; room?: string; sheet: boolean; soft: boolean }
	| {
			kind: 'wall' | 'floor' | 'ceiling' | 'coving' | 'skirting' | 'frame' | 'glass' | 'passage';
			room?: string;
	  };

/** What each mesh `buildHouse` made is. */
const solids = new WeakMap<THREE.Object3D, SolidTag>();

/** What a mesh of the house is, as `buildHouse` made it; undefined for anything else. */
export function solidTag(o: THREE.Object3D): SolidTag | undefined {
	return solids.get(o);
}

/**
 * The house's meshes, as drawn: every room's shell and windows, the passages
 * between rooms, and every piece as its parts, in place. Each mesh says which room
 * it is in (`userData.room`, the room whose reflections it takes) and what it is
 * (`solidTag`).
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
			if (o instanceof THREE.Mesh) solids.set(o, solid(o));
		}
	};
	const plan = skirtingPlan(scene);
	const holes = wells(scene);
	for (const r of scene.rooms) {
		const from = stage.scene.children.length;
		addRoomShell(stage, mats, scene, r, physical, night, plan, holes);
		// Drawn from its floor up; stood on its storey.
		for (const o of stage.scene.children.slice(from)) o.position.y += r.floor ?? 0;
		tag(from, r.name, (o) => ({ kind: shellKind(o), room: r.name }));
	}
	for (const p of passages(scene)) {
		const from = stage.scene.children.length;
		addPassage(stage, mats, scene, p);
		tag(from, p.room.name, () => ({ kind: 'passage', room: p.room.name }));
	}
	// Each piece as its parts, closed; a piece without parts is its box. A lamp's
	// meshes say which it is (`userData.lamp`), and its glowing part's that they glow.
	const lamps = new Map((scene.lights ?? []).map((l) => [l.piece, l]));
	for (const f of scene.furniture) {
		const room = nearestRoom(scene.rooms, f.cx, f.cz, f.y0 ?? 0);
		const lamp = lamps.get(pieceId(f));
		lamps.delete(pieceId(f));
		let glows = false;
		for (const mesh of pieceMeshes(stage, scene, f, mats)) {
			const from = stage.scene.children.length;
			stage.scene.add(mesh);
			if (night && materialOf(f, mesh) === LAMP_MATERIAL) addLampLight(stage, mesh);
			const part = solids.get(mesh);
			if (part?.kind !== 'part') throw new Error('`pieceMeshes` made a mesh without its part');
			if (f.movable) mesh.userData['movable'] = pieceId(f);
			if (lamp) {
				mesh.userData['lamp'] = lamp.id;
				mesh.userData['glows'] = part.part === lamp.glows;
				glows ||= part.part === lamp.glows;
			}
			tag(from, room, () => ({ ...part, room }));
		}
		if (lamp && !glows)
			throw new Error(`the light ${lamp.id}: ${pieceId(f)} has no part ${lamp.glows}`);
	}
	for (const l of lamps.values()) throw new Error(`the light ${l.id}: no piece ${l.piece}`);
}

/** What a piece's part mesh is made of, by its scene key (`pieceMeshes` keeps it). */
function materialOf(f: Furniture, mesh: THREE.Mesh): string | undefined {
	const key: unknown = mesh.userData['material'];
	return typeof key === 'string' ? key : f.material;
}

/**
 * A piece's parts as drawn, in place, with its joints at `state` (closed where it
 * says nothing): each mesh a part, named for the physics (`solidTag`), and what
 * moves says on which joint (`userData.moves`, `piece/part`). `buildHouse`
 * draws them closed; the physics sweeps a door or drawer through its travel by
 * drawing its parts along it.
 */
export function pieceMeshes(
	stage: Stage,
	scene: HouseScene,
	f: Furniture,
	mats: MaterialLibrary,
	state: JointState = {},
): THREE.Mesh[] {
	const parts = partsOf(f);
	return solidsOf(f, state).map((sol, k) => {
		const part = parts[k];
		const [hw, h, hd] = [sol.hw, sol.y1 - sol.y0, sol.hd];
		const spec = partMaterial(scene, f, part);
		// A picture goes on a box's front (+z, the fifth of its faces, the others plain),
		// or round a lathe (`byLength`).
		const onBox = spec.image !== undefined && part.shape === undefined;
		if (spec.image && ((!onBox && part.shape !== 'lathe') || part.split))
			throw new Error(`${pieceId(f)}/${part.id}: a picture goes on a box's front or round a lathe`);
		const shape = onBox ? new THREE.BoxGeometry(hw * 2, h, hd * 2) : partGeometry(part, hw, h, hd);
		const geom = stage.own(part.split ? split(shape, part.split.plane, hw, h, hd) : shape);
		// A sheet has two faces to see; a solid shows only its outside.
		const sheet = part.shape === 'folds' || part.shape === 'fronds';
		const side = sheet ? THREE.DoubleSide : THREE.FrontSide;
		const material = mats.get(spec, side);
		const plain = onBox ? mats.get({ ...spec, image: undefined }, side) : material;
		const mesh = new THREE.Mesh(
			geom,
			onBox
				? BOX_FACES.map((face) => (face === (spec.imageFace ?? 'front') ? material : plain))
				: part.split
					? [material, mats.get(named(scene, part.split.material), side)]
					: material,
		);
		mesh.position.set(sol.x, (sol.y0 + sol.y1) / 2, sol.z);
		mesh.rotation.y = sol.yaw;
		mesh.castShadow = mesh.receiveShadow = true;
		mesh.userData['material'] = part.material ?? f.material;
		const joint = movedBy(parts, part);
		if (joint) mesh.userData['moves'] = `${sol.piece}/${joint}`;
		solids.set(mesh, { kind: 'part', piece: sol.piece, part: sol.part, sheet, soft: !!f.soft });
		return mesh;
	});
}

/** The nearest part, this one or one it is fixed to, that moves on a joint. */
function movedBy(parts: Part[], part: Part): string | undefined {
	for (let p: Part | undefined = part; p; p = parts.find((q) => q.id === p?.parent))
		if (p.joint) return p.id;
	return undefined;
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
	plan: SkirtingPlan,
	holes: Well[],
): void {
	const pts = roomPerimeter(room);
	const into = inwardNormals(pts);
	const wallMat = mats.get(surfaceMaterial(scene, room, 'walls'), THREE.DoubleSide);
	const covingMat = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	const skirtingMat = mats.get(surfaceMaterial(scene, room, 'skirting'));
	const segs = segments(pts);
	// The wall `by` walls on from wall i, round the outline, skipping any of no length.
	const real = segs.map((s) => Math.hypot(s.bx - s.ax, s.bz - s.az) > 1e-6);
	const step = (i: number, by: number) => {
		let j = i;
		do j = (j + by + segs.length) % segs.length;
		while (!real[j] && j !== i);
		return j;
	};
	const neighbours = (i: number): [[number, number], [number, number]] => [
		into[step(i, -1)],
		into[step(i, 1)],
	];
	// A run's end is mitred where the next wall's run comes to the same corner, or an
	// open passage's side does (its board runs on round it); else it is closed.
	const runs = plan.runs.get(room) ?? [];
	const meetsBefore = (i: number) => {
		const j = step(i, -1);
		const len = Math.hypot(segs[j].bx - segs[j].ax, segs[j].bz - segs[j].az);
		return runs[j].some(([, a1]) => a1 > len - 1e-6);
	};
	const meetsAfter = (i: number) => runs[step(i, 1)].some(([a0]) => a0 < 1e-6);
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
		const [before, after] = neighbours(i);
		const along = (a: number): [number, number] => [
			s.ax + ((s.bx - s.ax) * a) / len,
			s.az + ((s.bz - s.az) * a) / len,
		];
		if (room.skirting)
			for (const [a0, a1] of runs[i])
				view.scene.add(
					shell(
						skirting(view, s, len, a0, a1, inward, room.skirting, skirtingMat, [
							a0 < 1e-6 && meetsBefore(i) ? before : plan.reveal(along(a0)),
							a1 > len - 1e-6 && meetsAfter(i) ? after : plan.reveal(along(a1)),
						]),
						'skirting',
					),
				);
	});
	// Round each open passage's sides that this room's surfaces take, a board on each,
	// meeting the rooms' boards on either side.
	for (const r of plan.reveals)
		if (r.room === room && room.skirting) {
			const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
			const seg = { ax: r.a[0], az: r.a[1], bx: r.b[0], bz: r.b[1] };
			view.scene.add(
				shell(
					skirting(view, seg, len, 0, len, r.into, room.skirting, skirtingMat, [
						plan.board(r.room, r.a),
						plan.board(r.other, r.b),
					]),
					'skirting',
				),
			);
		}
	const floor = mats.get(surfaceMaterial(scene, room, 'floor'), THREE.DoubleSide);
	const ceiling = mats.get(surfaceMaterial(scene, room, 'ceiling'), THREE.DoubleSide);
	const cut = (by: (w: Well) => Room) => holes.filter((w) => by(w) === room).map((w) => w.outline);
	view.scene.add(
		shell(
			facing(
				flat(
					view,
					pts,
					0,
					floor,
					cut((w) => w.room),
				),
				[0, 1, 0],
			),
			'floor',
		),
	);
	view.scene.add(
		shell(
			facing(
				flat(
					view,
					pts,
					scene.height,
					ceiling,
					cut((w) => w.under),
				),
				[0, -1, 0],
			),
			'ceiling',
		),
	);
	// Round each stairwell in its floor, the floor's depth: from the ceiling under it up.
	for (const w of holes.filter((h) => h.room === room)) {
		const yb = (w.under.floor ?? 0) + scene.height - (room.floor ?? 0);
		const into = inwardNormals([...w.outline, w.outline[0]]);
		segments([...w.outline, w.outline[0]]).forEach((s, i) => {
			const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
			view.scene.add(
				shell(facing(wallPanel(view, s, len, 0, len, yb, 0, wallMat), into[i]), 'wall'),
			);
		});
	}
}

/** Where every room's skirting runs and ends, and round which passages' sides it
 *  goes on: what a room's boards need to know of each other's, and of the sides'. */
interface SkirtingPlan {
	/** Each room's runs, by wall (`roomSkirting`). */
	runs: Map<Room, [number, number][][]>;
	/** Each open passage's sides: a board from `a` (in `room`) to `b` (in `other`),
	 *  facing `into` the opening. */
	reveals: {
		room: Room;
		other: Room;
		a: [number, number];
		b: [number, number];
		into: [number, number];
	}[];
	/** The side whose board meets a room's board ending at `p`: its facing; else none. */
	reveal(p: [number, number]): [number, number] | undefined;
	/** The wall's inward normal of `room`'s board ending at `p`; none if no board does. */
	board(room: Room, p: [number, number]): [number, number] | undefined;
}

function skirtingPlan(scene: HouseScene): SkirtingPlan {
	const near = (p: [number, number], q: [number, number]) =>
		Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
	const runs = new Map(scene.rooms.map((r) => [r, roomSkirting(scene, r)]));
	const ends = scene.rooms.flatMap((r) => {
		const pts = roomPerimeter(r);
		const into = inwardNormals(pts);
		return segments(pts).flatMap((s, i) => {
			const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
			return (runs.get(r)?.[i] ?? []).flatMap((run) =>
				run.map((a) => ({
					room: r,
					p: [s.ax + ((s.bx - s.ax) * a) / len, s.az + ((s.bz - s.az) * a) / len] as [
						number,
						number,
					],
					normal: into[i],
				})),
			);
		});
	});
	const reveals = passages(scene)
		.filter((p) => p.skirtingRound)
		.flatMap((p) =>
			p.jambs.map(([a, b], k) => {
				const into: [number, number] = k === 0 ? p.into : [-p.into[0], -p.into[1]];
				return {
					room: p.room,
					other: p.other,
					a: [a[0], a[2]] as [number, number],
					b: [b[0], b[2]] as [number, number],
					into,
				};
			}),
		);
	return {
		runs,
		reveals,
		reveal: (p) => reveals.find((r) => near(r.a, p) || near(r.b, p))?.into,
		board: (room, p) => ends.find((e) => e.room === room && near(e.p, p))?.normal,
	};
}

/** Names what a shell mesh is, for the physics (`solidTag`). */
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
	// A recessed window sits behind the wall's face, its reveal in between.
	const deep = g.recess ?? 0;
	const [bx, bz] = [-inward[0] * deep, -inward[1] * deep];
	if (deep > 0) addReveal(view, mats, scene, s, len, o, g, inward, deep);
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
			const x = s.ax + dx * along + inward[0] * 0.004 + bx;
			const z = s.az + dz * along + inward[1] * 0.004 + bz;
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
			back.position.set(s.ax + dx * along + bx, (p.yb + p.yt) / 2, s.az + dz * along + bz);
			back.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
			view.scene.add(shell(back, 'glass'));
			continue;
		}
		const geom = view.own(metricBox(p.a1 - p.a0, p.yt - p.yb, frame ? 0.07 : 0.006));
		const mesh = new THREE.Mesh(geom, mats.get(spec(key), THREE.DoubleSide));
		mesh.position.set(s.ax + dx * along + bx, (p.yb + p.yt) / 2, s.az + dz * along + bz);
		mesh.rotation.y = -Math.atan2(s.bz - s.az, s.bx - s.ax);
		mesh.castShadow = frame;
		mesh.receiveShadow = true;
		view.scene.add(shell(mesh, frame ? 'frame' : 'glass'));
	}
}

/** A recessed window's reveal, from the wall's face back to its frame: the sill
 *  (in `sillMaterial`, if it has one), the head and the jambs, in the wall's. */
function addReveal(
	view: Stage,
	mats: MaterialLibrary,
	scene: HouseScene,
	s: WallSeg,
	len: number,
	o: WallOpening,
	g: Glazing,
	inward: [number, number],
	deep: number,
): void {
	const room = scene.rooms.find((r) => r.openings?.includes(o));
	if (!room) throw new Error('a recessed window in no room');
	const wall = mats.get(surfaceMaterial(scene, room, 'walls'), THREE.DoubleSide);
	const sillSpec = g.sillMaterial ? scene.materials?.[g.sillMaterial] : undefined;
	const sill = sillSpec ? mats.get(sillSpec, THREE.DoubleSide) : wall;
	const q = revealQuads(s, len, inward, o, deep);
	const [ux, uz] = [(s.bx - s.ax) / len, (s.bz - s.az) / len];
	const faces: [P3[], THREE.Material, [number, number, number]][] = [
		[q.sill, sill, [0, 1, 0]],
		[q.head, wall, [0, -1, 0]],
		[q.jambs[0], wall, [ux, 0, uz]],
		[q.jambs[1], wall, [-ux, 0, -uz]],
	];
	for (const [quad, mat, dir] of faces) {
		const mesh = new THREE.Mesh(view.own(quadGeometry(quad)), mat);
		mesh.receiveShadow = mesh.castShadow = true;
		view.scene.add(shell(facing(mesh, dir), 'wall'));
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

/** Sides for a round shape of this radius: as few as keep each side within SAG of
 *  the true circle, which is what shows, up close, as a facet; finer is invisible,
 *  and each side is vertices the phone draws and the bake lights. A multiple of 4,
 *  so two parts of near radii that meet (a speaker's body and its cap) get the
 *  same, their rims meeting edge to edge; 8 for a button, 64 at most. */
function around(radius: number): number {
	const sides = radius > SAG ? Math.PI / Math.acos(1 - SAG / radius) : 0;
	return Math.max(8, Math.min(64, Math.ceil(sides / 4) * 4));
}

/** Metres a round shape's side may stand off its true circle, at most. */
const SAG = 0.0005;

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
		case 'loft': {
			if (!part.sections || part.sections.length < 2)
				throw new Error(`part ${part.id} is a loft without sections`);
			return loft(part.sections, hw, h, hd);
		}
		case 'extrude': {
			if (!part.outline || part.outline.length < 3)
				throw new Error(`part ${part.id} is an extrude without an outline`);
			// Drawn in the side's plane (depth, height), swept along its width, then turned
			// so the depth runs to the front (+z) and the sweep across x.
			const shape = new THREE.Shape(
				part.outline.map(([u, v]) => new THREE.Vector2((u - 0.5) * hd * 2, (v - 0.5) * h)),
			);
			return new THREE.ExtrudeGeometry(shape, { depth: hw * 2, bevelEnabled: false })
				.rotateY(-Math.PI / 2)
				.translate(hw, 0, 0);
		}
		case 'lathe': {
			if (!part.profile || part.profile.length < 2)
				throw new Error(`part ${part.id} is a lathe without a profile`);
			const pts = part.profile.map(([r, y]) => new THREE.Vector2(r, y - 0.5));
			// About the vertical, or lying: its length along the box's x or z.
			if (part.axis === 'x')
				return new THREE.LatheGeometry(pts, around(Math.max(h / 2, hd)))
					.rotateZ(-Math.PI / 2)
					.scale(hw * 2, h / 2, hd);
			if (part.axis === 'z')
				return new THREE.LatheGeometry(pts, around(Math.max(hw, h / 2)))
					.rotateX(Math.PI / 2)
					.scale(hw, h / 2, hd * 2);
			return byLength(
				new THREE.LatheGeometry(pts, around(Math.max(hw, hd))),
				part.profile,
				hw,
				h,
			).scale(hw, h, hd);
		}
		default:
			return metricBox(hw * 2, h, hd * 2);
	}
}

/** A box's faces as three's BoxGeometry orders its groups: +x, -x, +y, -y, +z, -z. */
const BOX_FACES = ['right', 'left', 'top', 'bottom', 'front', 'back'] as const;

/** A lathe's UVs along its profile by length (three's are by point), so a picture
 *  (`MaterialSpec.image`) wraps it evenly: v is the share of the profile's length
 *  from its first point, the radius in `hw`s and the height in `h`s. */
function byLength(
	geom: THREE.LatheGeometry,
	profile: [number, number][],
	hw: number,
	h: number,
): THREE.LatheGeometry {
	const along = [0];
	for (let j = 1; j < profile.length; j++)
		along.push(
			along[j - 1] +
				Math.hypot(
					(profile[j][0] - profile[j - 1][0]) * hw,
					(profile[j][1] - profile[j - 1][1]) * h,
				),
		);
	const total = along[along.length - 1] || 1;
	const uv = geom.getAttribute('uv');
	for (let i = 0; i < uv.count; i++) uv.setY(i, along[i % profile.length] / total);
	return geom;
}

/** `geom`, centred in a box (half-width `hw`, height `h`, half-depth `hd`), cut along
 *  `plane` ([a, b, c, d] over the point's shares of the box): unindexed, the
 *  triangles where a·u + b·v + c·w >= d in group 0, the rest in group 1. Each
 *  triangle the plane crosses is cut at it, every attribute taken along the edge. */
function split(
	geom: THREE.BufferGeometry,
	[a, b, c, d]: [number, number, number, number],
	hw: number,
	h: number,
	hd: number,
): THREE.BufferGeometry {
	const g = geom.index ? geom.toNonIndexed() : geom;
	const names = Object.keys(g.attributes);
	const attrs = names.map((n) => g.getAttribute(n));
	const pos = g.getAttribute('position');
	const side = (i: number) =>
		a * (pos.getX(i) / (2 * hw) + 0.5) +
		b * (pos.getY(i) / h + 0.5) +
		c * (pos.getZ(i) / (2 * hd) + 0.5) -
		d;
	// A corner: every attribute's values, and which side it is on.
	interface Corner {
		v: number[][];
		s: number;
	}
	const corner = (i: number): Corner => ({
		v: attrs.map((at) => Array.from({ length: at.itemSize }, (_, k) => at.getComponent(i, k))),
		s: side(i),
	});
	const between = (p: Corner, q: Corner): Corner => {
		const t = p.s / (p.s - q.s);
		return { v: p.v.map((x, n) => x.map((y, k) => y + (q.v[n][k] - y) * t)), s: 0 };
	};
	const out: [number[][][], number[][][]] = [[], []];
	for (let i = 0; i < pos.count; i += 3) {
		const tri = [corner(i), corner(i + 1), corner(i + 2)];
		// Each side's polygon (Sutherland–Hodgman against the plane), as a fan.
		for (const [k, keep] of [
			[0, (x: Corner) => x.s >= 0],
			[1, (x: Corner) => x.s < 0],
		] as const) {
			const poly: Corner[] = [];
			tri.forEach((p, j) => {
				const q = tri[(j + 1) % 3];
				if (keep(p)) poly.push(p);
				if (keep(p) !== keep(q)) poly.push(between(p, q));
			});
			for (let j = 1; j + 1 < poly.length; j++) out[k].push(poly[0].v, poly[j].v, poly[j + 1].v);
		}
	}
	const res = new THREE.BufferGeometry();
	names.forEach((n, ai) => {
		const size = attrs[ai].itemSize;
		const data = [...out[0], ...out[1]].flatMap((corner) => corner[ai]);
		res.setAttribute(n, new THREE.Float32BufferAttribute(data, size));
	});
	// A normal taken along an edge is shorter than one.
	const normal = res.getAttribute('normal');
	const v = new THREE.Vector3();
	for (let i = 0; i < normal.count; i++) {
		v.fromBufferAttribute(normal, i).normalize();
		normal.setXYZ(i, v.x, v.y, v.z);
	}
	res.addGroup(0, out[0].length, 0);
	res.addGroup(out[0].length, out[1].length, 1);
	if (g !== geom) g.dispose();
	geom.dispose();
	return res;
}

/** Ovals along x, [along, centre, half-height, half-depth] as shares of the box
 *  (half-width `hw`, height `h` from its middle, half-depth `hd`), skinned ring to
 *  ring, each end closed by a fan unless it is a tip. Its UVs in metres: along x,
 *  and round each ring. */
function loft(
	sections: [number, number, number, number][],
	hw: number,
	h: number,
	hd: number,
): THREE.BufferGeometry {
	const rings = sections.map(([u, c, ry, rz]) => ({
		x: (u - 0.5) * hw * 2,
		y: (c - 0.5) * h,
		ry: ry * h,
		rz: rz * hd,
	}));
	const sides = around(Math.max(...rings.map((r) => Math.max(r.ry, r.rz))));
	const pos: number[] = [];
	const uv: number[] = [];
	const index: number[] = [];
	for (const r of rings) {
		const girth = Math.PI * (r.ry + r.rz);
		for (let k = 0; k <= sides; k++) {
			const a = (2 * Math.PI * k) / sides;
			pos.push(r.x, r.y - r.ry * Math.cos(a), r.rz * Math.sin(a));
			uv.push(r.x, (girth * k) / sides);
		}
	}
	const at = (i: number, k: number) => i * (sides + 1) + k;
	for (let i = 0; i + 1 < rings.length; i++)
		for (let k = 0; k < sides; k++)
			index.push(
				at(i, k),
				at(i + 1, k),
				at(i + 1, k + 1),
				at(i, k),
				at(i + 1, k + 1),
				at(i, k + 1),
			);
	// Each end that is not a tip closed by a fan from its middle.
	for (const [i, out] of [
		[0, -1],
		[rings.length - 1, 1],
	] as const) {
		const r = rings[i];
		if (Math.max(r.ry, r.rz) < 1e-9) continue;
		const mid = pos.length / 3;
		pos.push(r.x, r.y, 0);
		uv.push(r.x, 0);
		for (let k = 0; k < sides; k++)
			index.push(...(out < 0 ? [mid, at(i, k), at(i, k + 1)] : [mid, at(i, k + 1), at(i, k)]));
	}
	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	geom.setIndex(index);
	geom.computeVertexNormals();
	// A tip's ring is one point, in triangles of no area: it faces along the loft.
	const normal = geom.getAttribute('normal');
	for (const [i, out] of [
		[0, -1],
		[rings.length - 1, 1],
	] as const) {
		if (Math.max(rings[i].ry, rings[i].rz) >= 1e-9) continue;
		for (let k = 0; k <= sides; k++) normal.setXYZ(at(i, k), out, 0, 0);
	}
	return geom;
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
		// A point at its foot and at its tip, where it has no width: two edges there
		// would meet in triangles of no area, which have no facing.
		for (let i = 0; i <= FROND_STEPS; i++) {
			const t = i / FROND_STEPS;
			const out = length * t * Math.cos(rise);
			const y = length * t * Math.sin(rise) - droop * length * t * t;
			const half = 0.07 * length * Math.pow(Math.sin(Math.PI * t), 0.8);
			pos.push(out * dx + half * dz, y, out * dz - half * dx);
			if (i > 0 && i < FROND_STEPS) pos.push(out * dx - half * dz, y, out * dz + half * dx);
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
	// A leaf's vertices: its foot, then a left and a right at each step between, then
	// its tip.
	const row = 2 * FROND_STEPS;
	for (let k = 0; k < FROND_LEAVES; k++) {
		const foot = k * row;
		const tip = foot + row - 1;
		const left = (i: number) => foot + 2 * i - 1;
		index.push(foot, left(1), left(1) + 1);
		for (let i = 1; i < FROND_STEPS - 1; i++) {
			const a = left(i);
			index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
		}
		index.push(left(FROND_STEPS - 1), tip, left(FROND_STEPS - 1) + 1);
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
 *  `depth` out from it. Where another board meets it (`meets`, at its start and end:
 *  that board's wall's inward normal) its end is mitred to that one's, as a moulding
 *  is cut; anywhere else (a doorway) it ends square, closed. */
function skirting(
	view: Stage,
	s: WallSeg,
	len: number,
	a0: number,
	a1: number,
	inward: [number, number],
	k: { height: number; depth: number },
	mat: THREE.Material,
	[before, after]: [[number, number] | undefined, [number, number] | undefined],
): THREE.Mesh {
	const [dx, dz] = [(s.bx - s.ax) / len, (s.bz - s.az) / len];
	const atWall = (a: number) => ({ x: s.ax + dx * a, z: s.az + dz * a });
	// The board's two ends, `u` out from the wall.
	const start = (u: number) =>
		before
			? mitre(atWall(a0), inward, before, u)
			: { x: atWall(a0).x + inward[0] * u, z: atWall(a0).z + inward[1] * u };
	const end = (u: number) =>
		after
			? mitre(atWall(a1), inward, after, u)
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
	if (!before)
		quad(
			[v3(start(0), 0), v3(start(d), 0), v3(start(d), h), v3(start(0), h)],
			along.clone().negate(),
		);
	if (!after) quad([v3(end(0), 0), v3(end(d), 0), v3(end(d), h), v3(end(0), h)], along);
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
	/** What can be picked up, as drawn, apart from `meshes`: no lightmap, no bake. */
	movables: THREE.Mesh[];
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

/** The room's outline as a horizontal surface at height `y`: its floor or ceiling,
 *  `holes` cut from it. ShapeGeometry's UVs are the outline's coordinates, so already
 *  in metres. */
function flat(
	view: Stage,
	pts: Pt[],
	y: number,
	mat: THREE.Material,
	holes: Pt[][] = [],
): THREE.Mesh {
	const at = (p: Pt) => new THREE.Vector2(p.x, p.z);
	// The outline closes on its first corner; the shape closes itself.
	const shape = new THREE.Shape(pts.slice(0, -1).map(at));
	const geom = view.own(
		withArea(new THREE.ShapeGeometry(holes.length === 0 ? shape : cutSquare(pts, holes))),
	);
	geom.rotateX(Math.PI / 2); // XY shape → XZ plane
	const mesh = new THREE.Mesh(geom, mat);
	mesh.position.y = y;
	mesh.receiveShadow = true;
	mesh.castShadow = y > 0; // the ceiling shades what is under it
	return mesh;
}

/**
 * The outline `pts` with `holes` cut from it, as rectangles: the grid every corner
 * of them makes, each cell of it in the outline and in no hole, a row's cells run
 * together. A triangulation takes a hole only inside its outline; a stairwell
 * against a room's walls meets it, and came out a wedge, floor over half its
 * stairs. Square corners only, as every room with a hole has.
 */
function cutSquare(pts: Pt[], holes: Pt[][]): THREE.Shape[] {
	for (const outline of [pts, ...holes])
		for (let i = 0; i < outline.length; i++) {
			const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
			if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.z - b.z) > 1e-6)
				throw new Error('a floor with a hole in it has a corner that is not square');
		}
	const sorted = (v: number[]) =>
		[...new Set(v.map((n) => Math.round(n * 1e6) / 1e6))].sort((a, b) => a - b);
	const all = [pts, ...holes].flat();
	const xs = sorted(all.map((p) => p.x));
	const zs = sorted(all.map((p) => p.z));
	const filled = (x: number, z: number) => holds(pts, x, z) && !holes.some((h) => holds(h, x, z));
	const out: THREE.Shape[] = [];
	for (let j = 0; j + 1 < zs.length; j++) {
		const [z0, z1] = [zs[j], zs[j + 1]];
		let from: number | undefined;
		for (let i = 0; i + 1 <= xs.length; i++) {
			const inside = i + 1 < xs.length && filled((xs[i] + xs[i + 1]) / 2, (z0 + z1) / 2);
			if (inside && from === undefined) from = xs[i];
			if (!inside && from !== undefined) {
				const x1 = xs[i];
				out.push(
					new THREE.Shape([
						new THREE.Vector2(from, z0),
						new THREE.Vector2(x1, z0),
						new THREE.Vector2(x1, z1),
						new THREE.Vector2(from, z1),
					]),
				);
				from = undefined;
			}
		}
	}
	return out;
}

/** `geom` unindexed, without the triangles of no area a triangulation leaves where a
 *  hole meets its outline: they face no way, so no light can be laid on them. */
function withArea(geom: THREE.BufferGeometry): THREE.BufferGeometry {
	const g = geom.toNonIndexed();
	geom.dispose();
	const pos = g.getAttribute('position');
	const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
	const keep: number[] = [];
	for (let i = 0; i < pos.count; i += 3) {
		a.fromBufferAttribute(pos, i);
		b.fromBufferAttribute(pos, i + 1);
		c.fromBufferAttribute(pos, i + 2);
		if (new THREE.Triangle(a, b, c).getArea() >= NO_AREA) keep.push(i, i + 1, i + 2);
	}
	const out = new THREE.BufferGeometry();
	for (const [name, attr] of Object.entries(g.attributes)) {
		const n = attr.itemSize;
		const data = new Float32Array(keep.length * n);
		keep.forEach((v, k) => {
			for (let j = 0; j < n; j++) data[k * n + j] = attr.array[v * n + j];
		});
		out.setAttribute(name, new THREE.BufferAttribute(data, n));
	}
	g.dispose();
	return out;
}

/** Square metres under which a triangle has no area, to rounding. */
export const NO_AREA = 1e-8;

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
