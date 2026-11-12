import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import { FACES } from './bake-file';
import { PROBE_STEP, fillGaps, lightDirection, probePoints, roomBoxes } from './probes';

const house = json as unknown as HouseScene;

describe('probePoints', () => {
	it('puts a probe in the middle of each cell, no further than PROBE_STEP apart, face by face', () => {
		const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0.3, 0.5));
		const { dims, at, normal } = probePoints(box);
		expect(dims).toEqual([4, 1, 2]);
		const n = 4 * 1 * 2;
		expect(at.length).toBe(n * FACES.length * 3);
		// The first probe of the first face, then the second (x fastest), then the
		// first of the second face.
		[0.125, 0.15, 0.125, 0.375, 0.15, 0.125].forEach((v, i) => expect(at[i]).toBeCloseTo(v, 6));
		expect([...normal.subarray(0, 3)]).toEqual(FACES[0]);
		expect([...normal.subarray(n * 3, n * 3 + 3)]).toEqual(FACES[1]);
		expect(1 / dims[0]).toBeLessThanOrEqual(PROBE_STEP);
	});
});

describe('fillGaps', () => {
	it('gives a probe inside something its neighbours’ light, and one none reaches none', () => {
		// Three probes in a row, one face each of six: the middle one's x face is
		// inside a wall; nothing reaches the others' faces.
		const dims: [number, number, number] = [3, 1, 1];
		const light = new Float32Array(3 * FACES.length * 3).fill(NaN);
		light.set([1, 1, 1, NaN, NaN, NaN, 3, 3, 3], 0);
		const out = fillGaps(light, dims);
		expect([...out.subarray(0, 9)]).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
		expect([...out.subarray(9)].every((v) => v === 0)).toBe(true);
		// The input stays as it was.
		expect(Number.isNaN(light[3])).toBe(true);
	});
});

describe('roomBoxes', () => {
	it('puts the bay in the living room’s box, as its meshes are tagged', () => {
		const boxes = roomBoxes(house);
		expect(boxes.has('bay')).toBe(false);
		const living = boxes.get('living');
		expect(living?.containsPoint(new THREE.Vector3(3, 1, 1.6))).toBe(true);
		// Upstairs from its floor to its ceiling.
		const landing = boxes.get('landing');
		expect([landing?.min.y, landing?.max.y]).toEqual([2.6, 2.6 + house.height]);
	});
});

describe('lightDirection', () => {
	it('is none from light all round, and the one way light comes from all of', () => {
		expect(lightDirection([1, 1, 1, 1, 1, 1]).directionality).toBeCloseTo(0);
		// Light from +x alone: only the face toward +x receives it.
		const one = lightDirection([2, 0, 0, 0, 0, 0]);
		expect(one.directionality).toBeCloseTo(1);
		expect(one.from.x).toBeCloseTo(1);
	});

	it('leans toward a window: more from it than from the room behind', () => {
		// A window toward -z: that face gets three times the others.
		const d = lightDirection([1, 1, 1, 1, 1, 3]);
		expect(d.from.z).toBeCloseTo(-1);
		expect(d.directionality).toBeCloseTo(2 / 8);
	});
});
