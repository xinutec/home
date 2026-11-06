import type * as THREE from 'three';
import {
	type JointLight,
	type Lightmap,
	encodeLightmap,
	lightChange,
	mergedChange,
	relaid,
} from './bake-file';
import { roomChecksum } from './baked-light';
import { bakeLightmap } from './baker';
import { type Surfaces, editedCells } from './edits';
import { type Joints, keptJointLights } from './joints';
import { type Lit, surfacesOf } from './room-builder';

/** Metres around where a door or drawer passes, or around what an edit added or
 *  took away, that it can change the light by more than lightChange's floor: the
 *  bake traces only there. */
const LIGHT_REACH = 0.75;

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
 */
export async function bakeHouse(
	renderer: THREE.WebGLRenderer,
	lit: Lit,
	joints: Joints,
	samples: number,
	progress: (done: number, of: number) => void,
	since?: LastBake,
	shutOnly = false,
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
	const region = (key: string) => joints.reach(key).expandByScalar(LIGHT_REACH);
	const kept = keptJointLights(
		since?.map.joints ?? [],
		joints.keys().map((key) => ({ key, at: joints.openAt(key), region: region(key) })),
		(r) => !!edited?.meets(r),
	);
	const keys = shutOnly ? [] : joints.keys().filter((k) => !kept.has(k));
	// Progress over every bake: the shut one, then each joint's.
	const report = (k: number) => (done: number) =>
		progress(k * samples + done, (keys.length + 1) * samples);
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
	const changes: JointLight[] = [];
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
	const seen = new Uint8Array(4 + surfaces.tris.byteLength + surfaces.salts.byteLength);
	new DataView(seen.buffer).setUint32(0, surfaces.salts.length, true);
	seen.set(new Uint8Array(surfaces.tris.buffer), 4);
	seen.set(new Uint8Array(surfaces.salts.buffer), 4 + surfaces.tris.byteLength);
	return {
		file: encodeLightmap(light, width, height, roomChecksum(lit), all, lit.atlas.layout),
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
				},
			}),
			joints: Object.fromEntries(changes.map((c) => [c.key, c.texels.length])),
			ms: times,
			seconds: Math.round((performance.now() - started) / 100) / 10,
		},
	};
}
