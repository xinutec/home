import { DataUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { HEADER, checksum, decodeLightmap, encodeLightmap } from './bake-file';

// The bytes as stored but not compressed: decoding then inflates nothing.
const raw = (b: Uint8Array) => Promise.resolve(b.slice());

describe('lightmap file', () => {
	it('reads back what it wrote, each pixel to within its own range', async () => {
		// A dark corner beside a window's glow: two decades apart.
		const light = new Float32Array([0.002, 0.0021, 0.0019, 0.5, 0.45, 0.4]);
		const file = encodeLightmap(light, 2, 1, 0xdeadbeef);
		const got = await decodeLightmap(file.buffer as ArrayBuffer, raw);
		expect(got?.checksum).toBe(0xdeadbeef);
		expect([got?.width, got?.height]).toEqual([2, 1]);
		for (let i = 0; i < 2; i++)
			for (let c = 0; c < 3; c++) {
				const v = DataUtils.fromHalfFloat(got?.data[i * 4 + c] ?? 0);
				expect(Math.abs(v - light[i * 3 + c]) / light[i * 3 + c]).toBeLessThan(0.02);
			}
	});

	it('refuses what is not a lightmap, or is cut short', async () => {
		expect(await decodeLightmap(new ArrayBuffer(8), raw)).toBeUndefined();
		const file = encodeLightmap(new Float32Array(12), 2, 2, 1);
		const short = file.slice(0, HEADER + 4);
		expect(await decodeLightmap(short.buffer, raw)).toBeUndefined();
		expect(
			await decodeLightmap(new TextEncoder().encode('{"rooms":[]}').buffer, raw),
		).toBeUndefined();
	});

	it('changes its checksum when a coordinate moves a micrometre, not for less', () => {
		const a = checksum([new Float32Array([1, 2, 0.5])]);
		expect(checksum([new Float32Array([1, 2, 0.5000001])])).toBe(a);
		expect(checksum([new Float32Array([1, 2, 0.50001])])).not.toBe(a);
	});
});
