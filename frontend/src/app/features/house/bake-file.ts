import { Box3, DataUtils, Vector3 } from 'three';
import type { Layout } from './unwrap';

/**
 * The baked lightmap, as served from scenes/house.bake: the irradiance on every
 * pixel of the atlas, RGB, stored as RGBM (colour, then a multiplier, 8 bits each:
 * light runs from a dark corner to the window's glow, and RGBM keeps a pixel's
 * own range), the bytes gzipped.
 *
 * Header, little-endian, 40 bytes: the magic "HBK5", the room's checksum (its
 * vertices and lightmap coordinates, as `checksum` reads them), the atlas's width
 * and height, the FNV-1a of the scene file's bytes it was baked from (e2e/bake.ts
 * writes it; tests/scene.test.ts fails while it differs from scenes/house.json's,
 * so no edit ships unbaked), the RGBM range (f32), how many joints' changes follow
 * the pixels (u32), how many charts its layout has (u32), how many lamps' light
 * follows the joints' (u32), and how many pairs' changes follow the lamps' (u32).
 *
 * After the pixels, each joint's change of light (`LightChange`): its key's length
 * (u16) and UTF-8 bytes, the value it was baked open at (f64), how many texels it
 * changes (u32), their indices in order as the gaps between them (u32 each, the
 * first from 0), and their RGB changes as half floats, every low byte and then
 * every high one: so laid out they compress, the gaps small, the high bytes alike.
 * Then each lamp's light, as a change from none (`lampLight`), the same way; then
 * each pair's change, the same way.
 *
 * Then the atlas's layout (`Layout`), chart by chart: its key's two hashes (u32
 * each) and twin number (u16), its corner in the atlas (u16 x, y), and its box in
 * the room (f32 min x, y, z, max x, y, z).
 */
export interface Lightmap {
	checksum: number;
	width: number;
	height: number;
	/** RGBA half floats, row 0 at the atlas's v = 0: a three.js DataTexture's data. */
	data: Uint16Array;
	/** What opening each door or drawer does to the light, with it shut in `data`. */
	joints: LightChange[];
	/** Each lamp's light, keyed by its id, from none: baked white at LAMP_BAKED_LUMENS
	 *  with no daylight, `at` 1. */
	lamps: LightChange[];
	/** What opening a joint does to a lamp's light (`pairKey`), as `joints` to the
	 *  daylight's: baked with that joint alone open at `at`, near it. */
	pairs: LightChange[];
	/** Where each chart is in the atlas: the page lays its atlas out to it. */
	layout: Layout;
}

/** What one change does to the light, a joint's opening or a lamp's switching on:
 *  baked with it at `at` and all else as it was, the texels whose light that
 *  changes, and by how much (RGB each). */
export interface LightChange {
	key: string;
	at: number;
	texels: Uint32Array;
	delta: Float32Array;
}

/** A change of light under this share of the brighter of the two is a bake's noise
 *  left over, not the joint's: two bakes share their random numbers, so a texel no
 *  path of which meets what moved comes out the same, and one that only a few do
 *  changes by little. */
const CHANGE_FLOOR = 0.02;

/** What opening `key` to `at` did to the light: the texels of `open` (that bake)
 *  that differ from `shut`'s by more than CHANGE_FLOOR. */
export function lightChange(
	key: string,
	at: number,
	shut: Float32Array,
	open: Float32Array,
): LightChange {
	const texels: number[] = [];
	const delta: number[] = [];
	for (let i = 0; i < shut.length / 3; i++) {
		let [most, bright] = [0, 0];
		for (let c = 0; c < 3; c++) {
			most = Math.max(most, Math.abs(open[i * 3 + c] - shut[i * 3 + c]));
			bright = Math.max(bright, open[i * 3 + c], shut[i * 3 + c]);
		}
		if (most <= CHANGE_FLOOR * bright) continue;
		texels.push(i);
		for (let c = 0; c < 3; c++) delta.push(open[i * 3 + c] - shut[i * 3 + c]);
	}
	return { key, at, texels: Uint32Array.from(texels), delta: Float32Array.from(delta) };
}

/** A lamp's light under this share of its bright end (the 99th percentile of its
 *  texels' luminance) is left out: with that lamp alone on, it is as good as dark,
 *  and with another, far under it. */
const LAMP_FLOOR = 0.01;

/** Mantissa bits a lamp's light is kept to: steps of 1.5%, about the bake's own
 *  noise, which in full precision fills the low bits and does not compress. */
const LAMP_BITS = 6;

/** A lamp's light `light` (RGB a texel) as the bake file keeps it: from none, `at`
 *  1, its texels over LAMP_FLOOR, to LAMP_BITS. */
export function lampLight(key: string, light: Float32Array): LightChange {
	const n = light.length / 3;
	const y = new Float32Array(n);
	for (let i = 0; i < n; i++)
		y[i] = 0.2126 * light[i * 3] + 0.7152 * light[i * 3 + 1] + 0.0722 * light[i * 3 + 2];
	const floor = LAMP_FLOOR * brightEnd(light);
	const texels: number[] = [];
	const delta: number[] = [];
	for (let i = 0; i < n; i++) {
		if (y[i] <= 0 || y[i] < floor) continue;
		texels.push(i);
		for (let c = 0; c < 3; c++) delta.push(toBits(light[i * 3 + c], LAMP_BITS));
	}
	return { key, at: 1, texels: Uint32Array.from(texels), delta: Float32Array.from(delta) };
}

/** What opening a joint does to a lamp's light (`pair`, from `lightChange`) as the
 *  bake file keeps it: its texels changed by LAMP_FLOOR of the lamp's bright end
 *  or more, to LAMP_BITS, as the lamp's own (`lamp`, from `lampLight`). The
 *  same again changes nothing, so a kept pair can be trimmed again. */
export function trimmedPair(pair: LightChange, lamp: LightChange): LightChange {
	const floor = LAMP_FLOOR * brightEnd(lamp.delta);
	const texels: number[] = [];
	const delta: number[] = [];
	pair.texels.forEach((t, i) => {
		const [r, g, b] = pair.delta.subarray(i * 3, i * 3 + 3);
		if (Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b) < floor) return;
		texels.push(t);
		delta.push(toBits(r, LAMP_BITS), toBits(g, LAMP_BITS), toBits(b, LAMP_BITS));
	});
	return { ...pair, texels: Uint32Array.from(texels), delta: Float32Array.from(delta) };
}

/** The 99th percentile of the luminance of `rgb`'s lit texels: a lamp's bright end. */
function brightEnd(rgb: Float32Array): number {
	const n = rgb.length / 3;
	const y = new Float32Array(n);
	for (let i = 0; i < n; i++)
		y[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
	const lit = y.filter((v) => v > 0).sort();
	return lit.length > 0 ? lit[Math.floor(0.99 * (lit.length - 1))] : 0;
}

/** `v` rounded to `bits` bits of mantissa. */
export function toBits(v: number, bits: number): number {
	if (v === 0 || !Number.isFinite(v)) return v;
	const step = 2 ** (Math.floor(Math.log2(Math.abs(v))) - bits);
	return Math.round(v / step) * step;
}

/** A joint and a lamp's pair: its key in `Lightmap.pairs`. */
export function pairKey(joint: string, lamp: string): string {
	return `${joint}|${lamp}`;
}

/** The joint and the lamp a pair's key names. */
export function pairOf(key: string): { joint: string; lamp: string } {
	const at = key.lastIndexOf('|');
	if (at < 0) throw new Error(`${key} is no pair`);
	return { joint: key.slice(0, at), lamp: key.slice(at + 1) };
}

const MAGIC = 0x354b4248; // "HBK5"
export const HEADER = 40;

/** The header and the uncompressed RGBM pixels of a lightmap. */
export function encodeLightmap(
	light: Float32Array,
	width: number,
	height: number,
	checksum: number,
	joints: LightChange[] = [],
	layout: Layout = new Map(),
	lamps: LightChange[] = [],
	pairs: LightChange[] = [],
): Uint8Array {
	let peak = 0;
	light.forEach((v, i) => {
		// One would make the range, and every pixel scaled by it, the same.
		if (!Number.isFinite(v)) throw new Error(`the light at texel ${Math.floor(i / 3)} is ${v}`);
		peak = Math.max(peak, v);
	});
	const range = Math.max(peak, 1e-6);
	const changes = [...joints, ...lamps, ...pairs];
	const keys = changes.map((j) => new TextEncoder().encode(j.key));
	const tail =
		changes.reduce((n, j, k) => n + 2 + keys[k].length + 8 + 4 + j.texels.length * 10, 0) +
		layout.size * CHART_BYTES;
	const out = new Uint8Array(HEADER + width * height * 4 + tail);
	const head = new DataView(out.buffer);
	head.setUint32(0, MAGIC, true);
	head.setUint32(4, checksum >>> 0, true);
	head.setUint32(8, width, true);
	head.setUint32(12, height, true);
	head.setFloat32(20, range, true);
	head.setUint32(24, joints.length, true);
	head.setUint32(28, layout.size, true);
	head.setUint32(32, lamps.length, true);
	head.setUint32(36, pairs.length, true);
	for (let i = 0; i < width * height; i++) {
		const [r, g, b] = [light[i * 3], light[i * 3 + 1], light[i * 3 + 2]];
		const m = Math.min(255, Math.ceil((Math.max(r, g, b) / range) * 255));
		const scale = m > 0 ? 255 / ((m / 255) * range) : 0;
		const at = HEADER + i * 4;
		out[at] = Math.min(255, Math.round(r * scale));
		out[at + 1] = Math.min(255, Math.round(g * scale));
		out[at + 2] = Math.min(255, Math.round(b * scale));
		out[at + 3] = m;
	}
	let at = HEADER + width * height * 4;
	changes.forEach((j, k) => {
		head.setUint16(at, keys[k].length, true);
		out.set(keys[k], at + 2);
		at += 2 + keys[k].length;
		head.setFloat64(at, j.at, true);
		head.setUint32(at + 8, j.texels.length, true);
		at += 12;
		j.texels.forEach((t, i) => {
			const gap = t - (i > 0 ? j.texels[i - 1] : 0);
			if (i > 0 && gap <= 0) throw new Error(`${j.key}'s texels are not in order`);
			head.setUint32(at, gap, true);
			at += 4;
		});
		const n = j.delta.length;
		j.delta.forEach((d, i) => {
			const h = DataUtils.toHalfFloat(d);
			out[at + i] = h & 0xff;
			out[at + n + i] = h >> 8;
		});
		at += n * 2;
	});
	for (const [key, p] of layout) {
		const [hashes, twin] = key.split('~');
		const [k1, k2] = hashes.split('.').map((h) => parseInt(h, 16));
		head.setUint32(at, k1, true);
		head.setUint32(at + 4, k2, true);
		head.setUint16(at + 8, Number(twin ?? 0), true);
		head.setUint16(at + 10, p.at[0], true);
		head.setUint16(at + 12, p.at[1], true);
		[...p.box.min.toArray(), ...p.box.max.toArray()].forEach((v, i) =>
			head.setFloat32(at + 14 + i * 4, v, true),
		);
		at += CHART_BYTES;
	}
	return out;
}

/** A chart's bytes in the layout. */
const CHART_BYTES = 38;

/** A joint's change of light after an edit: `fresh`, baked again where `retraced`,
 *  and `old` everywhere else, where the edit changed nothing. */
export function mergedChange(
	old: LightChange,
	fresh: LightChange,
	retraced: (texel: number) => boolean,
): LightChange {
	const out = new Map<number, ArrayLike<number>>();
	old.texels.forEach((t, i) => {
		if (!retraced(t)) out.set(t, old.delta.subarray(i * 3, i * 3 + 3));
	});
	fresh.texels.forEach((t, i) => {
		if (retraced(t)) out.set(t, fresh.delta.subarray(i * 3, i * 3 + 3));
	});
	const texels = Uint32Array.from([...out.keys()].sort((a, b) => a - b));
	const delta = new Float32Array(texels.length * 3);
	texels.forEach((t, i) => delta.set(out.get(t) ?? [0, 0, 0], i * 3));
	return { key: fresh.key, at: fresh.at, texels, delta };
}

/** A bake's raw sums (RGBA a pixel, `width` × `height`) in an atlas as wide but
 *  `rows` tall: every chart a layout keeps stays on its pixels; rows added are empty. */
export function relaid(
	raw: Float32Array,
	width: number,
	height: number,
	w: number,
	rows: number,
): Float32Array {
	if (w !== width) throw new Error(`an atlas ${width} wide relaid ${w} wide`);
	if (raw.length !== width * height * 4)
		throw new Error(`raw sums for ${raw.length / 4} pixels, not ${width} × ${height}`);
	const out = new Float32Array(w * rows * 4);
	out.set(raw.subarray(0, Math.min(height, rows) * w * 4));
	return out;
}

/** The lightmap in `buf`, its pixels inflated by `gunzip`; undefined if it is not one. */
export async function decodeLightmap(
	buf: ArrayBuffer,
	gunzip: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<Lightmap | undefined> {
	if (buf.byteLength < HEADER) return undefined;
	const head = new DataView(buf);
	if (head.getUint32(0, true) !== MAGIC) return undefined;
	const width = head.getUint32(8, true);
	const height = head.getUint32(12, true);
	const range = head.getFloat32(20, true);
	const px = await gunzip(new Uint8Array(buf, HEADER));
	if (px.length < width * height * 4) return undefined;
	const data = new Uint16Array(width * height * 4);
	const one = DataUtils.toHalfFloat(1);
	for (let i = 0; i < width * height; i++) {
		const k = ((px[i * 4 + 3] / 255) * range) / 255;
		for (let c = 0; c < 3; c++) data[i * 4 + c] = DataUtils.toHalfFloat(px[i * 4 + c] * k);
		data[i * 4 + 3] = one;
	}
	const joints = readChanges(px, width * height * 4, head.getUint32(24, true));
	if (!joints) return undefined;
	const lamps = readChanges(px, joints.at, head.getUint32(32, true));
	if (!lamps) return undefined;
	const pairs = readChanges(px, lamps.at, head.getUint32(36, true));
	if (!pairs) return undefined;
	const layout = readLayout(px, pairs.at, head.getUint32(28, true));
	if (!layout) return undefined;
	return {
		checksum: head.getUint32(4, true),
		width,
		height,
		data,
		joints: joints.changes,
		lamps: lamps.changes,
		pairs: pairs.changes,
		layout,
	};
}

/** The `count` charts' places in `px` from `at` on; undefined if cut short. */
function readLayout(px: Uint8Array, at: number, count: number): Layout | undefined {
	if (at + count * CHART_BYTES > px.length) return undefined;
	const view = new DataView(px.buffer, px.byteOffset, px.byteLength);
	const out: Layout = new Map();
	for (let k = 0; k < count; k++, at += CHART_BYTES) {
		const hashes = `${view.getUint32(at, true).toString(16)}.${view.getUint32(at + 4, true).toString(16)}`;
		const twin = view.getUint16(at + 8, true);
		const f = (i: number) => view.getFloat32(at + 14 + i * 4, true);
		out.set(twin ? `${hashes}~${twin}` : hashes, {
			at: [view.getUint16(at + 10, true), view.getUint16(at + 12, true)],
			box: new Box3(new Vector3(f(0), f(1), f(2)), new Vector3(f(3), f(4), f(5))),
		});
	}
	return out;
}

/** The `count` changes of light in `px` from `at` on, and where they end;
 *  undefined if cut short. */
function readChanges(
	px: Uint8Array,
	at: number,
	count: number,
): { changes: LightChange[]; at: number } | undefined {
	const view = new DataView(px.buffer, px.byteOffset, px.byteLength);
	const out: LightChange[] = [];
	for (let k = 0; k < count; k++) {
		if (at + 2 > px.length) return undefined;
		const len = view.getUint16(at, true);
		if (at + 2 + len + 12 > px.length) return undefined;
		const key = new TextDecoder().decode(px.subarray(at + 2, at + 2 + len));
		at += 2 + len;
		const value = view.getFloat64(at, true);
		const n = view.getUint32(at + 8, true);
		at += 12;
		if (at + n * 10 > px.length) return undefined;
		const texels = new Uint32Array(n);
		for (let i = 0; i < n; i++)
			texels[i] = (i > 0 ? texels[i - 1] : 0) + view.getUint32(at + i * 4, true);
		at += n * 4;
		const delta = new Float32Array(n * 3);
		for (let i = 0; i < n * 3; i++)
			delta[i] = DataUtils.fromHalfFloat(px[at + i] | (px[at + n * 3 + i] << 8));
		at += n * 6;
		out.push({ key, at: value, texels, delta });
	}
	return { changes: out, at };
}

/** A fingerprint of vertex positions and coordinates, to the micrometre (FNV-1a):
 *  a lightmap made for other geometry, however it changed, does not match. */
export function checksum(arrays: Iterable<number>[]): number {
	let h = 0x811c9dc5;
	for (const p of arrays)
		for (const x of p) {
			const v = Math.round(x * 1e6) | 0;
			for (let k = 0; k < 4; k++) {
				h ^= (v >>> (k * 8)) & 0xff;
				h = Math.imul(h, 0x01000193);
			}
		}
	return h >>> 0;
}
