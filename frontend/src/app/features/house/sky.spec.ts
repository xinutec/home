import { describe, expect, it } from 'vitest';
import {
	GROUND,
	GROUND_ALBEDO,
	SKY,
	overcastRadiance,
	overcastSkyImage,
	ZENITH_NITS,
	kelvinColour,
	lampRadiance,
	windowRadiance,
} from './sky';

describe('overcastRadiance', () => {
	it('is three times as bright at the zenith as at the horizon (CIE overcast sky)', () => {
		expect(overcastRadiance(Math.PI / 2) / overcastRadiance(0)).toBeCloseTo(3);
	});

	it('sends back from the ground what the sky lights it with, times its albedo', () => {
		// Horizontal illuminance under it is 7π/9 of the zenith radiance (here 1).
		expect(overcastRadiance(-0.3)).toBeCloseTo((GROUND_ALBEDO * 7 * Math.PI) / 9 / Math.PI);
		expect(overcastRadiance(-0.3)).toBeLessThan(overcastRadiance(0));
	});
});

describe('windowRadiance', () => {
	it('is what a vertical window of transmittance t passes on, diffusely, from sky and ground', () => {
		// Vertical illuminance from this sky: π/6 + 4/9 (zenith radiance 1), plus the
		// ground's radiance over its quarter sphere, π/2.
		const vertical = Math.PI / 6 + 4 / 9 + ((GROUND_ALBEDO * 7) / 9) * (Math.PI / 2);
		expect(windowRadiance(1)).toBeCloseTo(vertical / Math.PI, 3);
		expect(windowRadiance(0.8)).toBeCloseTo((0.8 * vertical) / Math.PI, 3);
	});
});

describe('overcastSkyImage', () => {
	it('puts the zenith where three looks up: the last row, v = 1 (equirectUv)', () => {
		const { width, height, data } = overcastSkyImage();
		const row = (y: number) => data[y * width * 4];
		// Its first row is the ground straight down; its last, the sky straight up.
		expect(row(0)).toBeCloseTo(overcastRadiance(-1) * GROUND[0], 5);
		const top = Math.PI / 2 - (0.5 / height) * Math.PI;
		expect(row(height - 1)).toBeCloseTo(overcastRadiance(top) * SKY[0], 5);
	});
});

describe('kelvinColour', () => {
	const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

	it('is of luminance 1, white near 6500 K and warmer below', () => {
		for (const k of [1900, 2700, 4000, 6500, 10000])
			expect(luminance(kelvinColour(k))).toBeCloseTo(1, 2);
		// D65 lies a little off the black body's curve, so 6504 K is near white, not white.
		const [r, g, b] = kelvinColour(6504);
		expect(Math.max(r, g, b) / Math.min(r, g, b)).toBeLessThan(1.1);
		const warm = kelvinColour(2700);
		expect(warm[0]).toBeGreaterThan(warm[1]);
		expect(warm[1]).toBeGreaterThan(warm[2]);
	});

	it('refuses a temperature off its fit', () => {
		expect(() => kelvinColour(1000)).toThrow(/off the fit/);
	});
});

describe('lampRadiance', () => {
	it('gives back the lumens over the surface it glows from', () => {
		// Φ = π L A, L in cd/m²: the trace's unit is the zenith's.
		expect(Math.PI * lampRadiance(806, 0.1) * ZENITH_NITS * 0.1).toBeCloseTo(806);
	});
});
