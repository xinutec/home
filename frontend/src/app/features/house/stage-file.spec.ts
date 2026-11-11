import { describe, expect, it } from 'vitest';
import { decodeStage, encodeStage } from './stage-file';

describe('a bake stage saved to a file', () => {
	it('comes back as it went: numbers, text, lists, and typed arrays inside them, bit for bit', () => {
		const value = {
			light: Float32Array.from([0.5, -0, Number.MIN_VALUE, 3.4e38, 1 / 3]),
			summed: 2048,
			ms: { build: 12.5, trace: 3 },
			change: {
				key: 'living-sideboard/drawer-left',
				at: 0.28,
				texels: Uint32Array.from([7, 9, 4_000_000_000]),
				delta: new Float32Array(0),
			},
			seen: Uint8Array.from([1, 2, 3]),
			lamps: [{ key: 'a', texels: Uint32Array.from([1]) }, undefined],
		};
		const back = decodeStage(encodeStage(value)) as typeof value;
		expect(back.summed).toBe(2048);
		expect(back.ms).toEqual(value.ms);
		expect(back.change.key).toBe(value.change.key);
		expect(back.change.texels).toBeInstanceOf(Uint32Array);
		expect([...back.change.texels]).toEqual([...value.change.texels]);
		expect(back.change.delta).toHaveLength(0);
		expect(back.light).toBeInstanceOf(Float32Array);
		// Bit for bit: a sum of light kept as it was, -0 and the least float too.
		expect(new Uint32Array(back.light.buffer, back.light.byteOffset, 5)).toEqual(
			new Uint32Array(value.light.buffer),
		);
		expect([...back.seen]).toEqual([1, 2, 3]);
		expect(back.lamps[0]?.texels).toBeInstanceOf(Uint32Array);
	});

	it('refuses bytes that are not a stage', () => {
		expect(() => decodeStage(new Uint8Array([1, 2, 3]))).toThrow();
	});
});
