import { DataUtils } from 'three';

/**
 * The baked lightmap, as served from scenes/house.bake: the irradiance on every
 * pixel of the atlas, RGB, stored as RGBM (colour, then a multiplier, 8 bits each:
 * light runs from a dark corner to the window's glow, and RGBM keeps a pixel's
 * own range), the bytes gzipped.
 *
 * Header, little-endian, 32 bytes: the magic "HBK2", the room's checksum (its
 * vertices and lightmap coordinates, as `checksum` reads them), the atlas's width
 * and height, the FNV-1a of the scene file's bytes it was baked from (e2e/bake.ts
 * writes it; tests/scene.test.ts fails while it differs from scenes/house.json's,
 * so no edit ships unbaked), the RGBM range (f32), how many joints' changes follow
 * the pixels (u32; 0 in a lightmap from before them), and a zero.
 *
 * After the pixels, each joint's change of light (`JointLight`): its key's length
 * (u16) and UTF-8 bytes, the value it was baked open at (f64), how many texels it
 * changes (u32), their indices (u32 each), and their RGB changes (half floats).
 */
export interface Lightmap {
	checksum: number;
	width: number;
	height: number;
	/** RGBA half floats, row 0 at the atlas's v = 0: a three.js DataTexture's data. */
	data: Uint16Array;
	/** What opening each door or drawer does to the light, with it shut in `data`. */
	joints: JointLight[];
}

/** What one joint's opening does to the light: baked with it open at `at` and all
 *  else shut, the texels whose light that changes, and by how much (RGB each). */
export interface JointLight {
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
): JointLight {
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

const MAGIC = 0x324b4248; // "HBK2"
export const HEADER = 32;

/** The header and the uncompressed RGBM pixels of a lightmap. */
export function encodeLightmap(
	light: Float32Array,
	width: number,
	height: number,
	checksum: number,
	joints: JointLight[] = [],
): Uint8Array {
	let peak = 0;
	for (const v of light) peak = Math.max(peak, v);
	const range = Math.max(peak, 1e-6);
	const keys = joints.map((j) => new TextEncoder().encode(j.key));
	const tail = joints.reduce((n, j, k) => n + 2 + keys[k].length + 8 + 4 + j.texels.length * 10, 0);
	const out = new Uint8Array(HEADER + width * height * 4 + tail);
	const head = new DataView(out.buffer);
	head.setUint32(0, MAGIC, true);
	head.setUint32(4, checksum >>> 0, true);
	head.setUint32(8, width, true);
	head.setUint32(12, height, true);
	head.setFloat32(20, range, true);
	head.setUint32(24, joints.length, true);
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
	joints.forEach((j, k) => {
		head.setUint16(at, keys[k].length, true);
		out.set(keys[k], at + 2);
		at += 2 + keys[k].length;
		head.setFloat64(at, j.at, true);
		head.setUint32(at + 8, j.texels.length, true);
		at += 12;
		for (const t of j.texels) {
			head.setUint32(at, t, true);
			at += 4;
		}
		for (const d of j.delta) {
			head.setUint16(at, DataUtils.toHalfFloat(d), true);
			at += 2;
		}
	});
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
	const joints = readJoints(px, width * height * 4, head.getUint32(24, true));
	if (!joints) return undefined;
	return { checksum: head.getUint32(4, true), width, height, data, joints };
}

/** The `count` joints' changes of light in `px` from `at` on; undefined if cut short. */
function readJoints(px: Uint8Array, at: number, count: number): JointLight[] | undefined {
	const view = new DataView(px.buffer, px.byteOffset, px.byteLength);
	const out: JointLight[] = [];
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
		for (let i = 0; i < n; i++) texels[i] = view.getUint32(at + i * 4, true);
		at += n * 4;
		const delta = new Float32Array(n * 3);
		for (let i = 0; i < n * 3; i++)
			delta[i] = DataUtils.fromHalfFloat(view.getUint16(at + i * 2, true));
		at += n * 6;
		out.push({ key, at: value, texels, delta });
	}
	return out;
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
