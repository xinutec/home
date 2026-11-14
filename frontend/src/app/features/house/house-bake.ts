import type * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import {
	type LightChange,
	type ProbeGrid,
	type Lightmap,
	encodeLightmap,
	lampLight,
	lightChange,
	mergedChange,
	pairKey,
	relaid,
	trimmedPair,
} from './bake-file';
import { roomChecksum, texelOwners } from './baked-light';
import { type BakeTimes, bakeLightmap, bakeProbes } from './baker';
import { type Surfaces, editedCells } from './edits';
import type { HouseScene } from './house.model';
import { type Joints, keptChanges } from './joints';
import { type Lit, surfacesOf } from './room-builder';
import { fillGaps, probePoints, roomBoxes, roomTag } from './probes';
import { nearestRoom } from './scene-geometry';

/** Metres around where a door or drawer passes, or around what an edit added or
 *  took away, that it can change the light by more than lightChange's floor: the
 *  bake traces only there. */
const LIGHT_REACH = 0.75;

/** A lamp to bake: its light's id, and its room (as its meshes are tagged,
 *  `roomBoxes`): its light is traced on that room's surfaces, and as probes in
 *  every other; the doors and drawers in it make pairs with it. */
export interface LampRegion {
	key: string;
	room: string;
	box: THREE.Box3;
}

/** Each of the scene's lights, with its room (its piece's). */
export function lampRegions(scene: HouseScene): LampRegion[] {
	const boxes = roomBoxes(scene);
	return (scene.lights ?? []).map((l) => {
		const f = scene.furniture.find((p) => p.id === l.piece);
		if (!f) throw new Error(`the light ${l.id}: no piece ${l.piece}`);
		const name = nearestRoom(scene.rooms, f.cx, f.cz, f.y0 ?? 0);
		const room = scene.rooms.find((r) => r.name === name);
		if (!room) throw new Error(`the light ${l.id} is in no room`);
		const tag = roomTag(room);
		const box = boxes.get(tag);
		if (!box) throw new Error(`no box for ${tag}`);
		return { key: l.id, room: tag, box };
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

/** What a kept stage must be, read back: the shapes `bakeHouse` puts. */
function isFloats(v: unknown): v is Float32Array {
	return v instanceof Float32Array;
}
function field(v: unknown, name: string): unknown {
	return typeof v === 'object' && v !== null
		? new Map<string, unknown>(Object.entries(v)).get(name)
		: undefined;
}
function isTimes(v: unknown): v is BakeTimes {
	return ['build', 'trace', 'read', 'finish'].every((k) => typeof field(v, k) === 'number');
}
function isChange(v: unknown): v is LightChange {
	return (
		typeof field(v, 'key') === 'string' &&
		typeof field(v, 'at') === 'number' &&
		field(v, 'texels') instanceof Uint32Array &&
		field(v, 'delta') instanceof Float32Array
	);
}
function isChanged(v: unknown): v is { change: LightChange; ms: BakeTimes } {
	return isChange(field(v, 'change')) && isTimes(field(v, 'ms'));
}
function isLit(v: unknown): v is { light: Float32Array; raw: Float32Array; ms: BakeTimes } {
	return isFloats(field(v, 'light')) && isFloats(field(v, 'raw')) && isTimes(field(v, 'ms'));
}
function isShut(v: unknown): v is {
	light: Float32Array;
	raw: Float32Array;
	summed: number;
	traced: number;
	ms: BakeTimes;
} {
	return (
		isLit(v) && typeof field(v, 'summed') === 'number' && typeof field(v, 'traced') === 'number'
	);
}

/**
 * Where a bake keeps each stage as it finishes (a layer's light, a joint's change),
 * so one stopped partway can be run again from where it was: a stage it has is
 * taken, not traced again. Its keys name the stage (`shut`, `joint:<key>`,
 * `lamp:<key>`, `pair:<joint>|<lamp>`, `probes:<lamp or daylight>`); what makes the
 * stages of one bake the same as another's (the scene, the code, the samples) is
 * its keeper's to tell.
 */
export interface BakeStore {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
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
 * then once more for each with it alone open, keeping what that changes. The doors
 * and drawers stand in the light but are not in the lightmap: they are lit from the
 * probes, as what is picked up is.
 * `progress` hears samples done of all. `since` the last bake, it traces only near
 * the surfaces that changed since then and on charts no bake has lit, and bakes
 * again only the joints near them, in those places only: the rest is that bake's.
 * `shutOnly`, it bakes no joint: the shut house's light alone, to measure.
 * Then each lamp's light, alone, on its room's surfaces (`lampRegions`), and what
 * opening each joint in that room does to it (a pair, `pairKey`), traced near the
 * joint from the lamp's own sums. A lamp is kept from the last bake, with its
 * pairs, where no edit reached its room and its every joint was kept; else it is
 * baked again, with all of them. Last, the daylight's and each lamp's light in
 * every room as probes (`probePoints`), each bake: they are few. `shutOnly` bakes
 * none.
 */
export async function bakeHouse(
	renderer: THREE.WebGLRenderer,
	lit: Lit,
	joints: Joints,
	samples: number,
	progress: (done: number, of: number) => void,
	since?: LastBake,
	shutOnly = false,
	/** The scene, for its lamps and rooms: without, no lamp is baked. */
	scene?: HouseScene,
	/** Where each stage is kept as it finishes, and found if a run before finished it. */
	store?: BakeStore,
): Promise<HouseBake> {
	/** A stage: the one kept, if there is one (its samples then reported done), else
	 *  `run` and kept. */
	const stage = async <T>(
		key: string,
		k: number,
		is: (v: unknown) => v is T,
		run: () => Promise<T>,
	): Promise<T> => {
		const had = await store?.get(key);
		if (had !== undefined) {
			if (!is(had)) throw new Error(`the bake's kept stage ${key} is not what that stage makes`);
			report(k)(samples);
			return had;
		}
		const made = await run();
		await store?.put(key, made);
		return made;
	};
	const lamps = scene ? lampRegions(scene) : [];
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
		lamps.map((l) => ({ key: l.key, at: 1, region: l.box })),
		(r) => !!edited?.meets(r),
	);
	// The joints in a lamp's room, which make pairs with it: in another, its light
	// barely reaches inside a cupboard.
	const near = (l: LampRegion) =>
		shutOnly
			? []
			: joints.keys().filter((j) => l.box.containsPoint(reach(j).getCenter(new Vector3())));
	const lastPairs = new Map((since?.map.pairs ?? []).map((p) => [p.key, p]));
	const keepsPairs = (l: LampRegion) =>
		near(l).every((j) => kept.has(j) && lastPairs.get(pairKey(j, l.key))?.at === joints.openAt(j));
	for (const l of lamps) if (!keepsPairs(l)) keptLamps.delete(l.key);
	const lampKeys = shutOnly ? [] : lamps.filter((l) => !keptLamps.has(l.key));
	const pairCount = lampKeys.reduce((n, l) => n + near(l).length, 0);
	// The light probes' sources: the daylight (undefined), then each lamp.
	const sources = shutOnly ? [] : [undefined, ...lamps.map((l) => l.key)];
	// Progress over every bake: the shut one, then each joint's, then each lamp's and
	// its pairs', then each source's probes.
	const report = (k: number) => (done: number) =>
		progress(
			k * samples + done,
			(keys.length + lampKeys.length + pairCount + sources.length + 1) * samples,
		);
	// Which room each texel is in, by its index in `rooms`: a lamp's light is traced
	// on its own room's.
	const boxes = scene ? roomBoxes(scene) : new Map<string, Box3>();
	const rooms = [...boxes.keys()];
	const roomOf = texelOwners(
		lit.meshes,
		(m) => rooms.indexOf(String(m.userData['room'])),
		width,
		height,
	);
	const { light, summed, raw, traced, ms } = await stage('shut', 0, isShut, async () => {
		const shut = await bakeLightmap(
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
		return {
			light: shut.light,
			summed: shut.summed,
			raw: shut.raw,
			traced: shut.traced,
			ms: shut.ms,
		};
	});
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
		const done = await stage(`joint:${key}`, k + 1, isChanged, async () => {
			const open = await bakeLightmap(renderer, lit, samples, 4, report(k + 1), {
				traces: (i, p) =>
					inside.containsPoint(p) && (!last || !edited || fresh[i] === 1 || edited.has(p)),
				base: raw,
			});
			const change = lightChange(key, at, light, open.light);
			return {
				change: last && open.owned ? mergedChange(last, change, open.owned) : change,
				ms: open.ms,
			};
		});
		joints.set(key, joints.closedAt(key));
		changes.push(done.change);
		for (const k of ['build', 'trace', 'read', 'finish'] as const) times.joints[k] += done.ms[k];
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
		const on = await stage(`lamp:${l.key}`, done, isLit, async () => {
			const alone = await bakeLightmap(
				renderer,
				lit,
				samples,
				4,
				report(done),
				{ traces: (i) => rooms[roomOf[i]] === l.room, base: none },
				l.key,
			);
			return { light: alone.light, raw: alone.raw, ms: alone.ms };
		});
		done++;
		baked.push(lampLight(l.key, on.light));
		for (const k of ['build', 'trace', 'read', 'finish'] as const) lampMs[k] += on.ms[k];
		// Each joint near it opened alone: the lamp's light traced again around it.
		for (const j of near(l)) {
			const at = joints.openAt(j);
			const pair = await stage(`pair:${pairKey(j, l.key)}`, done, isChanged, async () => {
				joints.set(j, at);
				const inside = region(j);
				const open = await bakeLightmap(
					renderer,
					lit,
					samples,
					4,
					report(done),
					{
						traces: (i, p) => inside.containsPoint(p) && rooms[roomOf[i]] === l.room,
						base: on.raw,
					},
					l.key,
				);
				joints.set(j, joints.closedAt(j));
				return { change: lightChange(pairKey(j, l.key), at, on.light, open.light), ms: open.ms };
			});
			done++;
			pairs.push(pair.change);
			for (const k of ['build', 'trace', 'read', 'finish'] as const) lampMs[k] += pair.ms[k];
		}
	}
	// The daylight and each lamp in every room, as probes, all a source's rooms in one
	// trace: a lamp's own room's are for what moves in it (its surfaces have their
	// layer), and the daylight's too (they have the lightmap).
	const boxed = rooms.map((room) => {
		const box = boxes.get(room);
		if (!box) throw new Error(`no box for ${room}`);
		return { room, box, ...probePoints(box) };
	});
	const at = new Float32Array(boxed.reduce((n, g) => n + g.at.length, 0));
	const normal = new Float32Array(at.length);
	let k = 0;
	for (const g of boxed) {
		at.set(g.at, k);
		normal.set(g.normal, k);
		k += g.at.length;
	}
	const probes: ProbeGrid[] = [];
	for (const lamp of sources) {
		const light = await stage(`probes:${lamp ?? 'daylight'}`, done, isFloats, () =>
			bakeProbes(renderer, lit, samples, { at, normal }, lamp, 4, report(done)),
		);
		done++;
		k = 0;
		for (const g of boxed) {
			const size = g.box.getSize(new Vector3());
			probes.push({
				...(lamp === undefined ? {} : { lamp }),
				room: g.room,
				min: [g.box.min.x, g.box.min.y, g.box.min.z],
				size: [size.x, size.y, size.z],
				dims: g.dims,
				light: fillGaps(light.subarray(k, k + g.at.length), g.dims),
			});
			k += g.at.length;
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
			probes,
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
