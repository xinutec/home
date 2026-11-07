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

	it('gives a small chart finer pixels than a large one, to a quarter of the texel', () => {
		// A 10 cm cube's faces: 16 pixels across each, at 6.25 mm; a 4 m floor at 2 cm.
		const small = new THREE.BoxGeometry(0.1, 0.1, 0.1).toNonIndexed();
		const floor = new THREE.PlaneGeometry(4, 4).toNonIndexed();
		const tiny = new THREE.BoxGeometry(0.02, 0.02, 0.02).toNonIndexed();
		const atlas = unwrap([small, floor, tiny], 0.02);
		const across = (g: THREE.BufferGeometry) => {
			const xs = placed(g, atlas)
				.flat()
				.map((c) => c.x);
			return Math.max(...xs) - Math.min(...xs);
		};
		expect(across(floor)).toBeCloseTo(200, 6);
		// Each of the cube's faces 16 pixels wide; six of them packed in a row, with gutters.
		const face = (g: THREE.BufferGeometry) => {
			const t = placed(g, atlas)
				.slice(0, 2)
				.flat()
				.map((c) => c.x);
			return Math.max(...t) - Math.min(...t);
		};
		expect(face(small)).toBeCloseTo(16, 6);
		// No finer than a quarter of the texel: 2 cm at 5 mm is 4 pixels.
		expect(face(tiny)).toBeCloseTo(4, 6);
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

	describe('over a previous layout', () => {
		const box = (x: number) =>
			new THREE.BoxGeometry(0.4, 0.2, 0.1).translate(x, 0, 0).toNonIndexed();
		const pixels = (g: THREE.BufferGeometry, atlas: { width: number; height: number }) =>
			placed(g, atlas).map((t) => t.map((c) => [Math.round(c.x * 1e3), Math.round(c.y * 1e3)]));

		it('keeps every chart where it was, and lays a new one out apart from them', () => {
			const a = box(0);
			const first = unwrap([a], 0.01);
			const kept = pixels(a, first);
			const b = box(2);
			const next = unwrap([a, b], 0.01, first.layout);
			expect(pixels(a, next)).toEqual(kept);
			const old = new THREE.Box2().setFromPoints(placed(a, next).flat());
			for (const t of placed(b, next)) {
				const tri = new THREE.Box2().setFromPoints(t);
				expect(tri.intersectsBox(old.clone().expandByScalar(-1e-3))).toBe(false);
			}
			// What came and what went, where they are in the room.
			expect(next.added).toHaveLength(6);
			expect(next.removed).toEqual([]);
			expect(next.added.every((c) => c.min.x > 1.7)).toBe(true);
		});

		it('takes a chart that moved as one gone from where it was and one come where it is', () => {
			const first = unwrap([box(0)], 0.01);
			const next = unwrap([box(0.5)], 0.01, first.layout);
			expect(next.removed).toHaveLength(6);
			expect(next.added).toHaveLength(6);
			expect(next.removed.every((c) => c.max.x < 0.3)).toBe(true);
		});

		it('takes a chart painted anew as a new one', () => {
			const a = box(0);
			const first = unwrap([a], 0.01, undefined, ['white']);
			expect(unwrap([a], 0.01, first.layout, ['white']).added).toEqual([]);
			expect(unwrap([a], 0.01, first.layout, ['red']).added).toHaveLength(6);
		});

		it('lays out as it would with none, when there was none', () => {
			const [a, b] = [box(0), box(2)];
			unwrap([a, b], 0.01);
			const fresh = [pixels(a, unwrap([a, b], 0.01)), pixels(b, unwrap([a, b], 0.01))];
			const atlas = unwrap([a, b], 0.01, new Map());
			expect([pixels(a, atlas), pixels(b, atlas)]).toEqual(fresh);
		});
	});
});
