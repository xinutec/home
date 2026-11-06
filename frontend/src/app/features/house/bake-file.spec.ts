import { DataUtils } from 'three';
import { describe, expect, it } from 'vitest';
import { HEADER, checksum, decodeLightmap, encodeLightmap, lightChange } from './bake-file';

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

	it('keeps of a joint opened only the texels whose light it changes, and by how much', () => {
		// Four texels: unchanged; a cabinet's inside, lit; a shadow cast, darker; a
		// change under the noise a bake leaves.
		const shut = new Float32Array([0.1, 0.1, 0.1, 0, 0, 0, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3]);
		const open = new Float32Array([
			0.1, 0.1, 0.1, 0.05, 0.04, 0.03, 0.15, 0.15, 0.15, 0.301, 0.3, 0.3,
		]);
		const change = lightChange('cab/door', -90, shut, open);
		expect([...change.texels]).toEqual([1, 2]);
		expect([...change.delta].map((v) => Math.round(v * 1000) / 1000)).toEqual([
			0.05, 0.04, 0.03, -0.05, -0.05, -0.05,
		]);
	});

	it('reads back each joint’s change of light with the lightmap', async () => {
		const shut = new Float32Array(12).fill(0.1);
		const open = shut.slice();
		open[3 * 3 + 1] = 0.3;
		const joints = [
			lightChange('cab/door', -90, shut, open),
			lightChange('cab/drawer', 0.28, shut, shut),
		];
		const file = encodeLightmap(shut, 2, 2, 7, joints);
		const got = await decodeLightmap(file.buffer as ArrayBuffer, raw);
		expect(got?.joints.map((j) => [j.key, j.at, [...j.texels]])).toEqual([
			['cab/door', -90, [3]],
			['cab/drawer', 0.28, []],
		]);
		expect(got?.joints[0].delta[1]).toBeCloseTo(0.2, 3);
		// A lightmap without them reads as one whose joints change nothing.
		const old = await decodeLightmap(encodeLightmap(shut, 2, 2, 7).buffer as ArrayBuffer, raw);
		expect(old?.joints).toEqual([]);
	});

	it('writes a joint’s texels as the gaps between them, its changes low bytes then high', async () => {
		const joint = {
			key: 'k',
			at: 1,
			texels: Uint32Array.from([5, 9]),
			delta: Float32Array.from([1, 2, 3, -1, -2, -3]),
		};
		const file = encodeLightmap(new Float32Array(3), 1, 1, 0, [joint]);
		const view = new DataView(file.buffer);
		// After the pixel: the key's length and byte, the value, the count.
		const at = HEADER + 4 + 2 + 1 + 8 + 4;
		expect([view.getUint32(at, true), view.getUint32(at + 4, true)]).toEqual([5, 4]);
		const halves = [...joint.delta].map((d) => DataUtils.toHalfFloat(d));
		const planes = [...halves.map((h) => h & 0xff), ...halves.map((h) => h >> 8)];
		expect([...file.subarray(at + 8, at + 8 + 12)]).toEqual(planes);
		const got = await decodeLightmap(file.buffer as ArrayBuffer, raw);
		expect([...(got?.joints[0].texels ?? [])]).toEqual([5, 9]);
		expect([...(got?.joints[0].delta ?? [])]).toEqual([1, 2, 3, -1, -2, -3]);
	});

	it('refuses a joint whose texels are not in order', () => {
		const joint = { key: 'k', at: 1, texels: Uint32Array.from([9, 5]), delta: new Float32Array(6) };
		expect(() => encodeLightmap(new Float32Array(3), 1, 1, 0, [joint])).toThrow(/in order/);
	});
});
