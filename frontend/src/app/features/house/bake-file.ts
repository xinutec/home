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
 * so no edit ships unbaked), the RGBM range (f32), and two zeros.
 */
export interface Lightmap {
	checksum: number;
	width: number;
	height: number;
	/** RGBA half floats, row 0 at the atlas's v = 0: a three.js DataTexture's data. */
	data: Uint16Array;
}

const MAGIC = 0x324b4248; // "HBK2"
export const HEADER = 32;

/** The header and the uncompressed RGBM pixels of a lightmap. */
export function encodeLightmap(
	light: Float32Array,
	width: number,
	height: number,
	checksum: number,
): Uint8Array {
	let peak = 0;
	for (const v of light) peak = Math.max(peak, v);
	const range = Math.max(peak, 1e-6);
	const out = new Uint8Array(HEADER + width * height * 4);
	const head = new DataView(out.buffer);
	head.setUint32(0, MAGIC, true);
	head.setUint32(4, checksum >>> 0, true);
	head.setUint32(8, width, true);
	head.setUint32(12, height, true);
	head.setFloat32(20, range, true);
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
	if (px.length !== width * height * 4) return undefined;
	const data = new Uint16Array(width * height * 4);
	const one = DataUtils.toHalfFloat(1);
	for (let i = 0; i < width * height; i++) {
		const k = ((px[i * 4 + 3] / 255) * range) / 255;
		for (let c = 0; c < 3; c++) data[i * 4 + c] = DataUtils.toHalfFloat(px[i * 4 + c] * k);
		data[i * 4 + 3] = one;
	}
	return { checksum: head.getUint32(4, true), width, height, data };
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
