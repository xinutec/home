import { describe, expect, it } from 'vitest';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import { collide, obstaclesOf } from './walk';
import type { Obstacles } from './walk';

const house = json as unknown as HouseScene;

/** Walks in a straight line in 5 cm steps, kept clear at each; where it ends. */
function walk(o: Obstacles, from: [number, number], to: [number, number]): [number, number] {
	let [x, z] = from;
	const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.05);
	for (let k = 0; k < steps; k++) {
		[x, z] = collide(x + (to[0] - from[0]) / steps, z + (to[1] - from[1]) / steps, o);
	}
	return [x, z];
}

describe('walking', () => {
	it('stops a walker its radius short of a wall', () => {
		const o: Obstacles = { walls: [[0, -1, 0, 1]], boxes: [] };
		const [x] = walk(o, [-1, 0], [1, 0]);
		expect(x).toBeCloseTo(-0.2, 6);
	});

	it('keeps a walker out of a turned box, and slides it along a side', () => {
		const o: Obstacles = {
			walls: [],
			boxes: [{ x: 0, z: 0, hw: 0.5, hd: 0.25, yaw: Math.PI / 2 }],
		};
		const [x, z] = walk(o, [-1, 0.3], [1, 0.3]);
		// Turned a quarter, the box is 0.5 wide in x: the walker stops at its side.
		expect(x).toBeLessThan(-0.25 - 0.2 + 1e-6);
		expect(Math.abs(z - 0.3)).toBeLessThan(0.3);
	});

	it('lets a walker through the living room’s doorway to the dining room, not through its wall', () => {
		const o = obstaclesOf(house);
		const [through] = walk(o, [0.4, 1.5], [-2.5, 1.5]);
		expect(through).toBeLessThan(-1.4);
		const [blocked] = walk(o, [0.4, 0.4], [-2.5, 0.4]);
		expect(blocked).toBeGreaterThan(-1.32);
	});

	it('does not let a walker step over the sofa', () => {
		const o = obstaclesOf(house);
		const [, z] = walk(o, [0.4, 2.0], [0.4, 3.6]);
		expect(z).toBeLessThan(2.85);
	});

	it('walks over the rug', () => {
		const o = obstaclesOf(house);
		const mat = house.furniture.find((f) => f.id === 'living-yoga-mat');
		expect(mat).toBeDefined();
		expect(
			o.boxes.some(
				(b) => Math.abs(b.x - (mat?.cx ?? 0)) < 1e-6 && Math.abs(b.z - (mat?.cz ?? 0)) < 1e-6,
			),
		).toBe(false);
	});
});
