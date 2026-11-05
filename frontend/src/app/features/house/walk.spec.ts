import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { Collider } from './walk';

const house = json as unknown as HouseScene;

/** Walks in a straight line in 5 cm steps, kept clear at each; where it ends. */
function walk(c: Collider, from: [number, number], to: [number, number]): [number, number] {
	let [x, z] = from;
	const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.05);
	for (let k = 0; k < steps; k++)
		[x, z] = c.push(x + (to[0] - from[0]) / steps, z + (to[1] - from[1]) / steps);
	return [x, z];
}

/** A box w × h × d with its centre at (x, y, z), turned `yaw` about the vertical. */
function box(
	w: number,
	h: number,
	d: number,
	x: number,
	y: number,
	z: number,
	yaw = 0,
): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
	m.position.set(x, y, z);
	m.rotation.y = yaw;
	return m;
}

/** The real house, as drawn. */
function drawn(): Collider {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, house, new MaterialLibrary(stage.own, false), false, false);
	return new Collider(stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh));
}

describe('walking', () => {
	it('stops a walker its radius short of a wall', () => {
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2.4).rotateY(Math.PI / 2));
		wall.position.set(0, 1.2, 0);
		const [x] = walk(new Collider([wall]), [-1, 0], [1, 0]);
		expect(x).toBeCloseTo(-0.2, 3);
	});

	it('keeps a walker out of a turned box, and slides it along a side', () => {
		// Turned a quarter, the box is 0.5 wide in x: the walker stops at its side.
		const c = new Collider([box(1, 0.8, 0.5, 0, 0.4, 0, Math.PI / 2)]);
		const [x, z] = walk(c, [-1, 0.3], [1, 0.3]);
		expect(x).toBeLessThan(-0.25 - 0.2 + 1e-3);
		expect(Math.abs(z - 0.3)).toBeLessThan(0.3);
	});

	it('walks over what lies below its knees, and not into what stands higher', () => {
		const rug = box(1, 0.01, 1, 0, 0.005, 0);
		expect(walk(new Collider([rug]), [-1, 0], [1, 0])[0]).toBeCloseTo(1, 6);
		const table = box(1, 0.75, 1, 0, 0.375, 0);
		expect(walk(new Collider([table]), [-1, 0], [1, 0])[0]).toBeLessThan(-0.69);
	});

	const house3d = drawn();

	it('lets a walker through the living room’s doorway to the dining room, not through its wall', () => {
		const [through] = walk(house3d, [0.4, 1.5], [-2.5, 1.5]);
		expect(through).toBeLessThan(-1.4);
		const [blocked] = walk(house3d, [0.4, 0.4], [-2.5, 0.4]);
		expect(blocked).toBeGreaterThan(-1.32);
	});

	it('does not let a walker step over the sofa', () => {
		const [, z] = walk(house3d, [0.4, 2.0], [0.4, 3.6]);
		expect(z).toBeLessThan(2.85);
	});

	it('walks over the yoga mat', () => {
		const mat = house.furniture.find((f) => f.id === 'living-yoga-mat');
		expect(mat).toBeDefined();
		// Along its middle, clear of the bean bag at its far end.
		const [cx, cz] = [mat?.cx ?? 0, (mat?.cz ?? 0) + 0.15];
		const [x] = walk(house3d, [cx - 0.6, cz], [cx - 0.1, cz]);
		expect(x).toBeCloseTo(cx - 0.1, 6);
	});
});
