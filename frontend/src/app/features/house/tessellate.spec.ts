import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { tessellate } from './tessellate';

/** Every triangle's edges and the summed area of an unindexed geometry. */
function measure(g: THREE.BufferGeometry): { longest: number; area: number; count: number } {
	const p = g.getAttribute('position');
	const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, i);
	let longest = 0;
	let area = 0;
	for (let t = 0; t < p.count; t += 3) {
		const [a, b, c] = [v(t), v(t + 1), v(t + 2)];
		longest = Math.max(longest, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
		area += new THREE.Triangle(a, b, c).getArea();
	}
	return { longest, area, count: p.count / 3 };
}

describe('tessellate', () => {
	it('splits a wall until no edge is longer than asked, its area and facing kept', () => {
		const wall = new THREE.PlaneGeometry(3, 2.4);
		const out = tessellate(wall, 0.12);
		const m = measure(out);
		expect(m.longest).toBeLessThanOrEqual(0.12 + 1e-9);
		expect(m.area).toBeCloseTo(3 * 2.4, 6);
		const n = new THREE.Vector3();
		new THREE.Triangle(
			new THREE.Vector3().fromBufferAttribute(out.getAttribute('position'), 0),
			new THREE.Vector3().fromBufferAttribute(out.getAttribute('position'), 1),
			new THREE.Vector3().fromBufferAttribute(out.getAttribute('position'), 2),
		).getNormal(n);
		expect(n.z).toBeCloseTo(1, 6);
	});

	it('carries every attribute to the new vertices, interpolated', () => {
		const out = tessellate(new THREE.PlaneGeometry(1, 1), 0.3);
		expect(Object.keys(out.attributes).sort()).toEqual(['normal', 'position', 'uv']);
		const uv = out.getAttribute('uv');
		for (let i = 0; i < uv.count; i++) {
			expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
			expect(uv.getX(i)).toBeLessThanOrEqual(1);
		}
	});

	it('leaves a triangle already small enough as it is', () => {
		expect(measure(tessellate(new THREE.PlaneGeometry(0.1, 0.1), 0.5)).count).toBe(2);
	});
});
