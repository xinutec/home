import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Furniture, HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { metricBox, pieceMeshes } from './room-builder';

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

describe('a lathe lying down', () => {
	/** A cone, widest at its profile's bottom, filling a 0.3 × 0.1 × 0.2 box, along `axis`. */
	function cone(axis: 'x' | 'z'): THREE.BufferGeometry {
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		const f: Furniture = {
			id: 'cone',
			cx: 0,
			cz: 0,
			w: 0.3,
			d: 0.2,
			h: 0.1,
			parts: [
				{
					id: 'body',
					size: [0.3, 0.1, 0.2],
					at: [0, 0.05, 0],
					shape: 'lathe',
					axis,
					profile: [
						[0, 0],
						[1, 0],
						[0, 1],
					],
				},
			],
		};
		const scene: HouseScene = { height: 2.4, rooms: [], furniture: [f] };
		const [mesh] = pieceMeshes(stage, scene, f, new MaterialLibrary(stage.own, false));
		return mesh.geometry;
	}
	/** The extent of the vertices within `eps` of the box's - end along `axis`, across it. */
	const across = (g: THREE.BufferGeometry, along: 0 | 2, eps: number) => {
		const p = g.getAttribute('position');
		const min = Math.min(...Array.from({ length: p.count }, (_, i) => p.getComponent(i, along)));
		const ys = Array.from({ length: p.count }, (_, i) => i)
			.filter((i) => p.getComponent(i, along) < min + eps)
			.map((i) => p.getY(i));
		return Math.max(...ys) - Math.min(...ys);
	};

	it('fills its box, its profile running along the axis from its - end', () => {
		for (const axis of ['x', 'z'] as const) {
			const g = cone(axis);
			g.computeBoundingBox();
			// Round as a polygon of many sides is: to within a few millimetres.
			const size = g.boundingBox?.getSize(new THREE.Vector3()).toArray() ?? [];
			[0.3, 0.1, 0.2].forEach((v, i) => expect(Math.abs(size[i] - v)).toBeLessThan(0.003));
			// The wide end is at the - end: across it there, the box's full height.
			expect(across(g, axis === 'x' ? 0 : 2, 1e-6)).toBeCloseTo(0.1, 3);
		}
	});
});

describe('an extrude', () => {
	it('sweeps its side outline across its width, its front to the box’s front', () => {
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		// A wedge, tall at its back: [back to front, bottom to top].
		const f: Furniture = {
			id: 'wedge',
			cx: 0,
			cz: 0,
			w: 0.3,
			d: 0.2,
			h: 0.1,
			parts: [
				{
					id: 'body',
					size: [0.3, 0.1, 0.2],
					at: [0, 0.05, 0],
					shape: 'extrude',
					outline: [
						[0, 0],
						[1, 0],
						[0, 1],
					],
				},
			],
		};
		const scene: HouseScene = { height: 2.4, rooms: [], furniture: [f] };
		const [mesh] = pieceMeshes(stage, scene, f, new MaterialLibrary(stage.own, false));
		const g = mesh.geometry;
		g.computeBoundingBox();
		const size = g.boundingBox?.getSize(new THREE.Vector3()).toArray() ?? [];
		[0.3, 0.1, 0.2].forEach((v, i) => expect(size[i]).toBeCloseTo(v, 6));
		// Its top is at its back.
		const p = g.getAttribute('position');
		const top = Array.from({ length: p.count }, (_, i) => i).filter((i) => p.getY(i) > 0.05 - 1e-6);
		expect(top.every((i) => Math.abs(p.getZ(i) + 0.1) < 1e-6)).toBe(true);
	});
});
