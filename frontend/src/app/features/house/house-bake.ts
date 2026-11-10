import type * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import {
	type LightChange,
	type Lightmap,
	encodeLightmap,
	lampLight,
	lightChange,
	mergedChange,
	pairKey,
	relaid,
	trimmedPair,
} from './bake-file';
import { roomChecksum } from './baked-light';
import { bakeLightmap } from './baker';
import { type Surfaces, editedCells } from './edits';
import type { HouseScene } from './house.model';
import { type Joints, keptChanges } from './joints';
import { type Lit, surfacesOf } from './room-builder';
import { nearestRoom, roomPerimeter } from './scene-geometry';

/** Metres around where a door or drawer passes, or around what an edit added or
 *  took away, that it can change the light by more than lightChange's floor: the
 *  bake traces only there. */
const LIGHT_REACH = 0.75;

/** Metres past its room's walls a lamp's light is baked to: through a doorway, a
 *  little way into the next room. Further on, it is left out. */
const LAMP_REACH = 1;

/** A lamp to bake: its light's id, the region its light is traced in, and its
 *  room's box, whose joints make pairs with it. */
export interface LampRegion {
	key: string;
	region: THREE.Box3;
	room: THREE.Box3;
}

/** Each of the scene's lights, with its room (its piece's), from floor to ceiling,
 *  and that grown by LAMP_REACH: where its light is traced. */
export function lampRegions(scene: HouseScene): LampRegion[] {
	return (scene.lights ?? []).map((l) => {
		const f = scene.furniture.find((p) => p.id === l.piece);
		if (!f) throw new Error(`the light ${l.id}: no piece ${l.piece}`);
		const name = nearestRoom(scene.rooms, f.cx, f.cz, f.y0 ?? 0);
		const room = scene.rooms.find((r) => r.name === name);
		if (!room) throw new Error(`the light ${l.id} is in no room`);
		const floor = room.floor ?? 0;
		const box = new Box3();
		for (const p of roomPerimeter(room)) {
			box.expandByPoint(new Vector3(p.x, floor, p.z));
			box.expandByPoint(new Vector3(p.x, floor + scene.height, p.z));
		}
		return { key: l.id, region: box.clone().expandByScalar(LAMP_REACH), room: box };
	});
}
/** The bake the page is fed, and what e2e/bake.ts keeps beside it: its raw sums, and
 *  the surfaces it saw. */
export interface LastBake {
	map: Lightmap;
	raw: Float32Array;
	was: Surfaces;
}

/** The last bake's raw sums and surfaces, as e2e/bake.ts serves them beside `map`:
 *  the sums after the atlas's width and height (u32 each), RGB summed and samples
 *  counted a pixel; the surfaces as how many triangles (u32), their corners (f32,
 *  nine each), then what each is made of (u32). */
export async function fetchLastBake(map: Lightmap): Promise<LastBake> {
	const bytes = async (url: string) => {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`${url}: ${r.status}`);
		return r.arrayBuffer();
	};
	const raw = new Float32Array(await bytes('/api/house/bake-raw'), 8);
	const tris = await bytes('/api/house/bake-tris');
	const n = new Uint32Array(tris, 0, 1)[0];
	return {
		map,
		raw,
		was: { tris: new Float32Array(tris, 4, n * 9), salts: new Uint32Array(tris, 4 + n * 36, n) },
	};
}

/** A bake of the house: the file as scenes/house.bake stores it before compression,
 *  its raw sums and the surfaces it saw (for the next bake since this one), its
 *  light, and what `data-baked` reports. */
export interface HouseBake {
	file: Uint8Array;
	raw: Float32Array;
	seen: Uint8Array;
	light: Float32Array;
	report: object;
}

/**
 * Bakes the house's lightmap, `samples` a pixel, with every door and drawer shut,
 * then once more for each with it alone open, keeping what that changes.
 * `progress` hears samples done of all. `since` the last bake, it traces only near
 * the surfaces that changed since then and on charts no bake has lit, and bakes
 * again only the joints near them, in those places only: the rest is that bake's.
 * `shutOnly`, it bakes no joint: the shut house's light alone, to measure.
 * Then each lamp's light, alone, in its region (`lampRegions`), and what opening
 * each joint whose region meets it does to that light (a pair, `pairKey`), traced
 * near the joint from the lamp's own sums. A lamp is kept from the last bake, with
 * its pairs, where no edit reached it and its every joint was kept; else it is
 * baked again, with all of them. `shutOnly` bakes none.
 */
export async function bakeHouse(
	renderer: THREE.WebGLRenderer,
	lit: Lit,
	joints: Joints,
	samples: number,
	progress: (done: number, of: number) => void,
	since?: LastBake,
	shutOnly = false,
	lamps: LampRegion[] = [],
): Promise<HouseBake> {
	const started = performance.now();
	const { width, height } = lit.atlas;
	// Where an edit can have changed the light: near the surfaces it changed, and on
	// every chart it made, which no bake has lit.
	const surfaces = surfacesOf(lit.meshes);
	const edited = since && editedCells(since.was, surfaces, LIGHT_REACH);
	const fresh = new Uint8Array(width * height);
	for (const [x, y, w, h] of lit.atlas.fresh)
		for (let v = y; v < y + h; v++) fresh.fill(1, v * width + x, v * width + x + w);
	// Where each joint's parts pass, once: it is worked out pose by pose.
	const reaches = new Map(joints.keys().map((k) => [k, joints.reach(k)]));
	const reach = (key: string) => {
		const r = reaches.get(key);
		if (!r) throw new Error(`no joint ${key}`);
		return r;
	};
	const region = (key: string) => reach(key).clone().expandByScalar(LIGHT_REACH);
	const kept = keptChanges(
		since?.map.joints ?? [],
		joints.keys().map((key) => ({ key, at: joints.openAt(key), region: region(key) })),
		(r) => !!edited?.meets(r),
	);
	const keys = shutOnly ? [] : joints.keys().filter((k) => !kept.has(k));
	const keptLamps = keptChanges(
		since?.map.lamps ?? [],
		lamps.map((l) => ({ ...l, at: 1 })),
		(r) => !!edited?.meets(r),
	);
	// The joints in a lamp's room, which make pairs with it: in another, its light
	// barely reaches inside a cupboard.
	const near = (l: LampRegion) =>
		shutOnly
			? []
			: joints.keys().filter((j) => l.room.containsPoint(reach(j).getCenter(new Vector3())));
	const lastPairs = new Map((since?.map.pairs ?? []).map((p) => [p.key, p]));
	const keepsPairs = (l: LampRegion) =>
		near(l).every((j) => kept.has(j) && lastPairs.get(pairKey(j, l.key))?.at === joints.openAt(j));
	for (const l of lamps) if (!keepsPairs(l)) keptLamps.delete(l.key);
	const lampKeys = shutOnly ? [] : lamps.filter((l) => !keptLamps.has(l.key));
	const pairCount = lampKeys.reduce((n, l) => n + near(l).length, 0);
	// Progress over every bake: the shut one, then each joint's, then each lamp's and
	// its pairs'.
	const report = (k: number) => (done: number) =>
		progress(k * samples + done, (keys.length + lampKeys.length + pairCount + 1) * samples);
	const { light, summed, raw, traced, ms } = await bakeLightmap(
		renderer,
		lit,
		samples,
		4,
		report(0),
		since &&
			edited && {
				traces: (i, at) => fresh[i] === 1 || edited.has(at),
				base: relaid(since.raw, since.map.width, since.map.height, width, height),
			},
	);
	const changes: LightChange[] = [];
	// Each phase's time, the shut bake's and the joints' summed.
	const times = { shut: ms, joints: { build: 0, trace: 0, read: 0, finish: 0 } };
	for (const [k, key] of keys.entries()) {
		// Only near what moves: further off, what it changes is under lightChange's floor.
		const at = joints.openAt(key);
		joints.set(key, at);
		const inside = region(key);
		// Its change from the last bake, where the edit came near it: traced again only
		// where the edit could have changed it, kept elsewhere.
		const last = since?.map.joints.find((j) => j.key === key && j.at === at);
		const open = await bakeLightmap(renderer, lit, samples, 4, report(k + 1), {
			traces: (i, p) =>
				inside.containsPoint(p) && (!last || !edited || fresh[i] === 1 || edited.has(p)),
			base: raw,
		});
		joints.set(key, joints.closedAt(key));
		const change = lightChange(key, at, light, open.light);
		changes.push(last && open.owned ? mergedChange(last, change, open.owned) : change);
		for (const k of ['build', 'trace', 'read', 'finish'] as const) times.joints[k] += open.ms[k];
	}
	// Every joint, in the order they are keyed: the kept ones as they were.
	const all = (shutOnly ? [] : joints.keys())
		.map((key) => kept.get(key) ?? changes.find((c) => c.key === key))
		.filter((c) => c !== undefined);
	// Each lamp from none: no light anywhere it is not traced.
	const none = new Float32Array(width * height * 4);
	const baked: LightChange[] = [];
	const pairs: LightChange[] = [];
	const lampMs = { build: 0, trace: 0, read: 0, finish: 0 };
	let done = keys.length + 1;
	for (const l of lampKeys) {
		const on = await bakeLightmap(
			renderer,
			lit,
			samples,
			4,
			report(done++),
			{ traces: (_, p) => l.region.containsPoint(p), base: none },
			l.key,
		);
		baked.push(lampLight(l.key, on.light));
		for (const k of ['build', 'trace', 'read', 'finish'] as const) lampMs[k] += on.ms[k];
		// Each joint near it opened alone: the lamp's light traced again around it.
		for (const j of near(l)) {
			const at = joints.openAt(j);
			joints.set(j, at);
			const inside = region(j);
			const open = await bakeLightmap(
				renderer,
				lit,
				samples,
				4,
				report(done++),
				{ traces: (_, p) => inside.containsPoint(p) && l.region.containsPoint(p), base: on.raw },
				l.key,
			);
			joints.set(j, joints.closedAt(j));
			pairs.push(lightChange(pairKey(j, l.key), at, on.light, open.light));
			for (const k of ['build', 'trace', 'read', 'finish'] as const) lampMs[k] += open.ms[k];
		}
	}
	const lamped = (shutOnly ? [] : lamps)
		.map(({ key }) => keptLamps.get(key) ?? baked.find((c) => c.key === key))
		.filter((c) => c !== undefined);
	// Every pair, a kept lamp's as they were, each trimmed by its lamp's light.
	const paired = (shutOnly ? [] : lamps).flatMap((l) => {
		const lamp = lamped.find((c) => c.key === l.key);
		if (!lamp) throw new Error(`no light for the lamp ${l.key}`);
		return near(l)
			.map((j) =>
				keptLamps.has(l.key)
					? lastPairs.get(pairKey(j, l.key))
					: pairs.find((p) => p.key === pairKey(j, l.key)),
			)
			.filter((c) => c !== undefined)
			.map((p) => trimmedPair(p, lamp));
	});
	const seen = new Uint8Array(4 + surfaces.tris.byteLength + surfaces.salts.byteLength);
	new DataView(seen.buffer).setUint32(0, surfaces.salts.length, true);
	seen.set(new Uint8Array(surfaces.tris.buffer), 4);
	seen.set(new Uint8Array(surfaces.salts.buffer), 4 + surfaces.tris.byteLength);
	return {
		file: encodeLightmap(
			light,
			width,
			height,
			roomChecksum(lit),
			all,
			lit.atlas.layout,
			lamped,
			paired,
		),
		raw,
		seen,
		light,
		report: {
			atlas: [width, height],
			covered: lit.atlas.charts,
			samples: summed,
			...(since && {
				since: {
					added: lit.atlas.added.length,
					removed: lit.atlas.removed.length,
					traced,
					cells: edited?.size ?? 0,
					kept: [...kept.keys()].length,
					keptLamps: [...keptLamps.keys()].length,
				},
			}),
			joints: Object.fromEntries(changes.map((c) => [c.key, c.texels.length])),
			lamps: Object.fromEntries(baked.map((c) => [c.key, c.texels.length])),
			pairs: Object.fromEntries(pairs.map((c) => [c.key, c.texels.length])),
			ms: { ...times, lamps: lampMs },
			seconds: Math.round((performance.now() - started) / 100) / 10,
		},
	};
}
