import { describe, expect, it } from 'vitest';
import { deltaE, fitReflectance, regionMean, toLab, toLinear, toSrgb } from './colour-match';
import type { Rgb } from './colour-match';

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

describe('fitReflectance', () => {
	// A room where every pixel is exposure · light · reflectance, light per region.
	const srgb = (lin: number[]): Rgb => [toSrgb(lin[0]), toSrgb(lin[1]), toSrgb(lin[2])];
	const camera = (light: number, rho: number[], k: number[]) =>
		srgb(rho.map((v, c) => v * light * k[c]));

	it('finds the true reflectances from a photo, whatever its exposure and white balance', () => {
		const truth: Record<string, number[]> = {
			ceiling: [0.85, 0.85, 0.85],
			wall: [0.5, 0.48, 0.42],
			carpet: [0.18, 0.18, 0.2],
		};
		const guess: Record<string, Rgb> = {
			ceiling: [0.7, 0.7, 0.7],
			wall: [0.3, 0.3, 0.3],
			carpet: [0.3, 0.3, 0.3],
		};
		const light: Record<string, number> = { ceiling: 0.4, wall: 0.7, carpet: 0.9 };
		const photoK = [1.1, 1.0, 0.8]; // a warm white balance
		const renderK = [0.6, 0.6, 0.6];
		const samples = Object.keys(truth).map((m) => ({
			material: m,
			area: 100,
			render: camera(light[m], guess[m], renderK),
			photo: camera(light[m], truth[m], photoK),
		}));
		const fit = fitReflectance(samples, guess, { material: 'ceiling', reflectance: 0.85 });
		for (const m of Object.keys(truth))
			for (let c = 0; c < 3; c++) expect(fit[m][c]).toBeCloseTo(truth[m][c], 2);
	});

	it('weights two regions of one material by their area', () => {
		const one: Rgb = [0.5, 0.5, 0.5];
		const fit = fitReflectance(
			[
				{ material: 'a', area: 1, render: srgb([0.5, 0.5, 0.5]), photo: srgb([0.5, 0.5, 0.5]) },
				{ material: 'w', area: 3, render: srgb([0.2, 0.2, 0.2]), photo: srgb([0.1, 0.1, 0.1]) },
				{ material: 'w', area: 1, render: srgb([0.2, 0.2, 0.2]), photo: srgb([0.3, 0.3, 0.3]) },
			],
			{ a: one, w: one },
			{ material: 'a', reflectance: 0.5 },
		);
		// (3·0.1 + 0.3) / (4·0.2) = 0.75 of the guess.
		expect(fit['w'][0]).toBeCloseTo(0.375, 2);
		expect(toLinear(255)).toBe(1);
	});
});
