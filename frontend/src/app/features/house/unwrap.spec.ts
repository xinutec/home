import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { unwrap } from './unwrap';

/** Each triangle's corners in the atlas, in pixels. */
function placed(
	g: THREE.BufferGeometry,
	atlas: { width: number; height: number },
): THREE.Vector2[][] {
	const uv = g.getAttribute('uv1');
	return Array.from({ length: uv.count / 3 }, (_, t) =>
		[0, 1, 2].map(
			(k) => new THREE.Vector2(uv.getX(t * 3 + k) * atlas.width, uv.getY(t * 3 + k) * atlas.height),
		),
	);
}

describe('unwrap', () => {
	it('lays a box out as six charts at the asked density, apart and inside the atlas', () => {
		const box = new THREE.BoxGeometry(0.4, 0.2, 0.1).toNonIndexed();
		const atlas = unwrap([box], 0.01);
		const tris = placed(box, atlas);
		for (const t of tris)
			for (const c of t) {
				expect(c.x).toBeGreaterThanOrEqual(0);
				expect(c.x).toBeLessThanOrEqual(atlas.width);
				expect(c.y).toBeLessThanOrEqual(atlas.height);
			}
		// The 0.4 × 0.2 face: 40 × 20 pixels at a centimetre a pixel.
		const front = tris.slice(8, 10).flat();
		const span = (f: (v: THREE.Vector2) => number) =>
			Math.max(...front.map(f)) - Math.min(...front.map(f));
		const [long, short] = [span((v) => v.x), span((v) => v.y)].sort((a, b) => b - a);
		expect(long).toBeCloseTo(40, 4);
		expect(short).toBeCloseTo(20, 4);
		// No two charts share a pixel: the six faces' boxes do not overlap.
		const boxes = [0, 2, 4, 6, 8, 10].map((t) =>
			new THREE.Box2().setFromPoints([...tris[t], ...tris[t + 1]]),
		);
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i].clone().expandByScalar(-0.5);
				expect(a.intersectsBox(boxes[j].clone().expandByScalar(-0.5))).toBe(false);
			}
	});

	it('keeps a curved part in few charts, not one a triangle', () => {
		const tube = new THREE.CylinderGeometry(0.1, 0.1, 0.5, 32, 1, true).toNonIndexed();
		const before = unwrap([tube], 0.01);
		expect(before.charts).toBeGreaterThan(0);
		// 64 triangles round the side; a chart spans up to 45 degrees of it.
		const tris = placed(tube, before);
		const distinct = new Set(tris.map((t) => `${Math.round(t[0].y / 40)}`));
		expect(distinct.size).toBeLessThan(12);
	});

	it('unwraps the same geometry alike every time', () => {
		const a = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
		const b = a.clone();
		unwrap([a], 0.02);
		unwrap([b], 0.02);
		expect(Array.from(a.getAttribute('uv1').array)).toEqual(
			Array.from(b.getAttribute('uv1').array),
		);
	});

	it('refuses indexed geometry, whose shared corners cannot be in two charts', () => {
		expect(() => unwrap([new THREE.BoxGeometry(1, 1, 1)], 0.02)).toThrow();
	});
});
