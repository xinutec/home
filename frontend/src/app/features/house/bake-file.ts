import { DataUtils } from 'three';

/**
 * The baked light, as served from scenes/house.bake: for each vertex of the
 * merged room, in order, the irradiance on its front and on its back (a double-
 * sided wall is lit differently on each face), RGB, as half floats.
 *
 * Header, little-endian u32 each: the magic "HBK1", the room's checksum (its
 * vertices, as `checksum` reads them), the vertex count, and the FNV-1a of the
 * scene file's bytes it was baked from (e2e/bake.ts writes it; tests/scene.test.ts
 * fails while it differs from scenes/house.json's, so no edit ships unbaked).
 */
export interface Bake {
	checksum: number;
	front: Float32Array;
	back: Float32Array;
}

const MAGIC = 0x314b4248; // "HBK1"

export function encodeBake(b: Bake): ArrayBuffer {
	const count = b.front.length / 3;
	const buf = new ArrayBuffer(16 + count * 3 * 2 * 2);
	const head = new DataView(buf);
	head.setUint32(0, MAGIC, true);
	head.setUint32(4, b.checksum >>> 0, true);
	head.setUint32(8, count, true);
	head.setUint32(12, 0, true);
	const halves = new Uint16Array(buf, 16);
	for (let i = 0; i < count * 3; i++) {
		halves[i] = DataUtils.toHalfFloat(b.front[i]);
		halves[count * 3 + i] = DataUtils.toHalfFloat(b.back[i]);
	}
	return buf;
}

/** The bake in `buf`, or undefined if it is not one. */
export function decodeBake(buf: ArrayBuffer): Bake | undefined {
	if (buf.byteLength < 16) return undefined;
	const head = new DataView(buf);
	if (head.getUint32(0, true) !== MAGIC) return undefined;
	const count = head.getUint32(8, true);
	if (buf.byteLength !== 16 + count * 12) return undefined;
	const halves = new Uint16Array(buf, 16);
	const front = new Float32Array(count * 3);
	const back = new Float32Array(count * 3);
	for (let i = 0; i < count * 3; i++) {
		front[i] = DataUtils.fromHalfFloat(halves[i]);
		back[i] = DataUtils.fromHalfFloat(halves[count * 3 + i]);
	}
	return { checksum: head.getUint32(4, true), front, back };
}

/** A fingerprint of vertex positions, to the millimetre (FNV-1a): a bake made
 *  for other geometry, however it changed, does not match. */
export function checksum(positions: Iterable<number>[]): number {
	let h = 0x811c9dc5;
	for (const p of positions)
		for (const x of p) {
			const v = Math.round(x * 1000) | 0;
			for (let k = 0; k < 4; k++) {
				h ^= (v >>> (k * 8)) & 0xff;
				h = Math.imul(h, 0x01000193);
			}
		}
	return h >>> 0;
}
