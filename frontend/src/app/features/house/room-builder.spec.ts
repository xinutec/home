import { describe, expect, it } from 'vitest';
import { metricBox } from './room-builder';

/** Each face's [u, v] extent, in BoxGeometry's face order (+x, -x, +y, -y, +z, -z). */
function spans(w: number, h: number, d: number): [number, number][] {
	const uv = metricBox(w, h, d).getAttribute('uv');
	return [0, 1, 2, 3, 4, 5].map((face) => {
		const us = [0, 1, 2, 3].map((k) => uv.getX(face * 4 + k));
		const vs = [0, 1, 2, 3].map((k) => uv.getY(face * 4 + k));
		return [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)];
	});
}

describe('metricBox', () => {
	it('runs the grain (u) along each face’s longer side, in metres', () => {
		// A tall unit: up its front and sides, along its top.
		const [px, , py, , pz] = spans(0.6, 2.1, 0.5);
		expect(px[0]).toBeCloseTo(2.1);
		expect(px[1]).toBeCloseTo(0.5);
		expect(pz[0]).toBeCloseTo(2.1);
		expect(py[0]).toBeCloseTo(0.6);
		// A long shelf keeps it along its length.
		const [, , top, , front] = spans(1.3, 0.02, 0.3);
		expect(front[0]).toBeCloseTo(1.3);
		expect(top[0]).toBeCloseTo(1.3);
	});
});
