import { Box3, DataUtils, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
	HEADER,
	checksum,
	decodeLightmap,
	encodeLightmap,
	lampLight,
	toBits,
	trimmedPair,
	lightChange,
	mergedChange,
	pairKey,
	pairOf,
	relaid,
} from './bake-file';

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

	it('refuses light that is not a number, which would darken every pixel', () => {
		const light = new Float32Array([0.2, 0.2, 0.2, NaN, 0.1, 0.1]);
		expect(() => encodeLightmap(light, 2, 1, 1)).toThrow('the light at texel 1 is NaN');
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

	it('reads back each lamp’s light and each pair apart from the joints, before the layout', async () => {
		const none = new Float32Array(12);
		const lit = none.slice().fill(0.5, 3, 6);
		const joint = lightChange('cab/door', -90, none, lit);
		const lamp = lightChange('ceiling-lamp', 1, none, lit);
		const layout = new Map([
			[
				'1.2',
				{ at: [0, 0] as [number, number], box: new Box3(new Vector3(), new Vector3(1, 1, 1)) },
			],
		]);
		const pair = lightChange(pairKey('cab/door', 'ceiling-lamp'), -90, none, lit);
		const file = encodeLightmap(none, 2, 2, 7, [joint], layout, [lamp], [pair]);
		const got = await decodeLightmap(file.buffer as ArrayBuffer, raw);
		expect(got?.joints.map((j) => j.key)).toEqual(['cab/door']);
		expect(got?.pairs.map((p) => [pairOf(p.key), p.at])).toEqual([
			[{ joint: 'cab/door', lamp: 'ceiling-lamp' }, -90],
		]);
		expect(got?.lamps.map((l) => [l.key, l.at, [...l.texels]])).toEqual([['ceiling-lamp', 1, [1]]]);
		expect(got?.lamps[0].delta[0]).toBeCloseTo(0.5, 3);
		expect([...(got?.layout.keys() ?? [])]).toEqual(['1.2']);
	});

	it('keeps a lamp’s light over a hundredth of its bright end, to six bits', () => {
		// 200 texels lit 1, one at 0.02, one at 0.005, one dark.
		const light = new Float32Array(203 * 3);
		light.fill(1, 0, 600);
		light.fill(0.02, 600, 603);
		light.fill(0.005, 603, 606);
		const lamp = lampLight('salt', light);
		expect(lamp.texels).toHaveLength(201);
		expect(lamp.texels.at(-1)).toBe(200);
		expect(toBits(1 + 1 / 100, 6)).toBe(1 + 1 / 64);
		expect(toBits(0.3, 6)).toBeCloseTo(0.3, 2);
		expect(Math.abs(toBits(0.3, 6) - 0.3) / 0.3).toBeLessThan(1 / 128);
	});

	it('trims a pair to what is over its lamp’s floor, and again to the same', () => {
		// The lamp: 200 texels lit 1. The pair changes three by 0.5, 0.02 and 0.005.
		const lamp = lampLight('salt', new Float32Array(600).fill(1));
		const pair = {
			key: pairKey('cab/door', 'salt'),
			at: -90,
			texels: Uint32Array.from([3, 4, 5]),
			delta: Float32Array.from([0.5, 0.5, 0.5, -0.02, -0.02, -0.02, 0.005, 0.005, 0.005]),
		};
		const trimmed = trimmedPair(pair, lamp);
		expect([...trimmed.texels]).toEqual([3, 4]);
		expect(trimmed.delta[3]).toBeCloseTo(-0.02, 3);
		expect(trimmedPair(trimmed, lamp)).toEqual(trimmed);
	});

	it('refuses a joint whose texels are not in order', () => {
		const joint = { key: 'k', at: 1, texels: Uint32Array.from([9, 5]), delta: new Float32Array(6) };
		expect(() => encodeLightmap(new Float32Array(3), 1, 1, 0, [joint])).toThrow(/in order/);
	});

	it('reads back the layout of the atlas it was baked in', async () => {
		const layout = new Map([
			[
				'1a2b.3c4d',
				{
					at: [2, 3] as [number, number],
					box: new Box3(new Vector3(0, 0, 0), new Vector3(1, 2, 3)),
				},
			],
			[
				'1a2b.3c4d~1',
				{
					at: [40, 3] as [number, number],
					box: new Box3(new Vector3(-1, 0, 0.5), new Vector3(0, 0.25, 1)),
				},
			],
		]);
		const joint = { key: 'k', at: 1, texels: Uint32Array.from([0]), delta: new Float32Array(3) };
		const file = encodeLightmap(new Float32Array(3), 1, 1, 0, [joint], layout);
		const got = await decodeLightmap(file.buffer as ArrayBuffer, raw);
		expect(
			[...(got?.layout ?? [])].map(([k, p]) => [k, p.at, p.box.min.toArray(), p.box.max.toArray()]),
		).toEqual([
			['1a2b.3c4d', [2, 3], [0, 0, 0], [1, 2, 3]],
			['1a2b.3c4d~1', [40, 3], [-1, 0, 0.5], [0, 0.25, 1]],
		]);
		expect(got?.joints).toHaveLength(1);
		// One baked before layouts has none: the page lays its atlas out afresh.
		const old = await decodeLightmap(
			encodeLightmap(new Float32Array(3), 1, 1, 0).buffer as ArrayBuffer,
			raw,
		);
		expect(old?.layout.size).toBe(0);
	});

	it('keeps a raw bake’s pixels where they were in an atlas grown or shrunk below', () => {
		// 1 wide, RGBA a pixel: two rows become three, then one.
		const raw = Float32Array.from([1, 1, 1, 8, 2, 2, 2, 8]);
		expect([...relaid(raw, 1, 2, 1, 3)]).toEqual([1, 1, 1, 8, 2, 2, 2, 8, 0, 0, 0, 0]);
		expect([...relaid(raw, 1, 2, 1, 1)]).toEqual([1, 1, 1, 8]);
		expect(() => relaid(raw, 1, 2, 2, 2)).toThrow(/wide/);
	});

	it('keeps a joint’s old change of light wherever its bake did not trace again', () => {
		const j = (texels: number[], d: number) => ({
			key: 'k',
			at: 1,
			texels: Uint32Array.from(texels),
			delta: Float32Array.from(texels.flatMap(() => [d, d, d])),
		});
		// Traced again: texels 4 to 6. Old changes at 2, 5; new ones at 4, 9 (9 not traced).
		const merged = mergedChange(j([2, 5], 1), j([4, 9], 2), (t) => t >= 4 && t <= 6);
		expect([...merged.texels]).toEqual([2, 4]);
		expect([...merged.delta]).toEqual([1, 1, 1, 2, 2, 2]);
	});
});
