import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyOf, penetration } from './contact';

/** A box w × h × d with its centre at (x, y, z). */
function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
	m.position.set(x, y, z);
	return m;
}

/** A wall on z = 0, 4 m along x and 2.4 m tall, facing its room at +z. */
function wall(): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4));
	m.position.set(0, 1.2, 0);
	m.userData['facing'] = new THREE.Vector3(0, 0, 1);
	return m;
}

const body = (m: THREE.Mesh) => bodyOf('test', m);

describe('penetration', () => {
	it('is how far one box goes into another', () => {
		const a = body(box(1, 1, 1, 0, 0.5, 0));
		const b = body(box(1, 1, 1, 0.95, 0.5, 0));
		expect(penetration(a, b)).toBeCloseTo(0.05, 2);
	});

	it('is nothing for boxes that only touch, or stand apart', () => {
		const a = body(box(1, 1, 1, 0, 0.5, 0));
		expect(penetration(a, body(box(1, 1, 1, 1, 0.5, 0)))).toBeLessThan(0.002);
		expect(penetration(a, body(box(1, 1, 1, 1.2, 0.5, 0)))).toBe(0);
	});

	it('finds two boards crossed like a plus sign, where no corner is in the other', () => {
		const a = body(box(1, 0.1, 0.02, 0, 0.5, 0));
		const b = body(box(0.02, 0.1, 1, 0, 0.5, 0));
		expect(penetration(a, b)).toBeGreaterThan(0.005);
	});

	it('finds a box through a wall, but not one standing against it', () => {
		const w = body(wall());
		expect(penetration(body(box(0.5, 0.5, 0.5, 0, 0.5, 0.2)), w)).toBeCloseTo(0.05, 2);
		expect(penetration(body(box(0.5, 0.5, 0.5, 0, 0.5, 0.25)), w)).toBeLessThan(0.002);
	});

	it('does not count a box beyond the end of a wall as behind it', () => {
		expect(penetration(body(box(0.5, 0.5, 0.5, 2.5, 0.5, -0.5)), body(wall()))).toBe(0);
	});

	it('finds a box pushed into a skirting board along the wall', () => {
		const skirting = body(box(4, 0.17, 0.02, 0, 0.085, 0.01));
		expect(penetration(body(box(0.5, 0.5, 0.5, 0, 0.25, 0.25)), skirting)).toBeCloseTo(0.02, 2);
		expect(penetration(body(box(0.5, 0.5, 0.5, 0, 0.25, 0.27)), skirting)).toBeLessThan(0.002);
	});
});
