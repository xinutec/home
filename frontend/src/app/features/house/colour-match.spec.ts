import { describe, expect, it } from 'vitest';
import { deltaE, regionMean, toLab } from './colour-match';

describe('toLab', () => {
	it('puts sRGB white at L 100 and black at L 0, with no colour', () => {
		const w = toLab([255, 255, 255]);
		expect(w[0]).toBeCloseTo(100, 0);
		expect(Math.abs(w[1]) + Math.abs(w[2])).toBeLessThan(0.5);
		expect(toLab([0, 0, 0])[0]).toBeCloseTo(0, 5);
	});

	it('puts sRGB mid-grey (119) near L 50', () => {
		expect(toLab([119, 119, 119])[0]).toBeCloseTo(50, 0);
	});
});

describe('deltaE', () => {
	it('is 0 for one colour and grows with the difference', () => {
		expect(deltaE([120, 120, 120], [120, 120, 120])).toBe(0);
		expect(deltaE([120, 120, 120], [122, 122, 122])).toBeLessThan(2);
		expect(deltaE([120, 120, 120], [160, 120, 120])).toBeGreaterThan(10);
	});
});

describe('regionMean', () => {
	it('averages in linear light, not in sRGB numbers', () => {
		// Half black, half white: the light averages to half, which is sRGB 188, not 128.
		const w = 2;
		const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
		const m = regionMean(px, w, { x: 0, y: 0, w: 2, h: 1 });
		expect(m[0]).toBeCloseTo(188, 0);
	});
});
