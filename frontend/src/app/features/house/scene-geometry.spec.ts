import { describe, expect, it } from 'vitest';

import type { Room } from './house.model';
import {
	bounds,
	covingProfile,
	mitre,
	inwardNormals,
	skirtingRuns,
	glazingLayout,
	passages,
	perimeter,
	roomAt,
	roomPerimeter,
	segments,
	wallPanels,
} from './scene-geometry';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('perimeter', () => {
	it('walks a square: four 90° turns come back to the start', () => {
		// First wall heads +x (turn 0), then three right turns.
		const pts = perimeter([
			[0, 4],
			[90, 4],
			[90, 4],
			[90, 4],
		]);
		expect(pts).toHaveLength(5);
		close(pts[1].x, 4);
		close(pts[1].z, 0);
		close(pts[2].x, 4);
		close(pts[2].z, 4);
		close(pts[3].x, 0);
		close(pts[3].z, 4);
		close(pts[4].x, 0); // closed loop
		close(pts[4].z, 0);
	});

	it('honours the start corner and initial heading', () => {
		const pts = perimeter([[0, 2]], { x: 10, z: 5 }, 90); // 90° = +z
		close(pts[0].x, 10);
		close(pts[0].z, 5);
		close(pts[1].x, 10);
		close(pts[1].z, 7);
	});
});

describe('roomPerimeter', () => {
	it('reads start/heading/walls off the Room shape (heading defaults to 0)', () => {
		const room: Room = { start: [1, 2], walls: [[0, 3]] };
		const pts = roomPerimeter(room);
		close(pts[1].x, 4);
		close(pts[1].z, 2);
	});
});

describe('segments', () => {
	it('turns n points into n-1 consecutive wall segments', () => {
		const segs = segments([
			{ x: 0, z: 0 },
			{ x: 4, z: 0 },
			{ x: 4, z: 4 },
		]);
		expect(segs).toEqual([
			{ ax: 0, az: 0, bx: 4, bz: 0 },
			{ ax: 4, az: 0, bx: 4, bz: 4 },
		]);
	});

	it('is empty for fewer than two points', () => {
		expect(segments([])).toEqual([]);
		expect(segments([{ x: 1, z: 1 }])).toEqual([]);
	});
});

describe('roomAt', () => {
	const square = (name: string, x: number): Room => ({
		name,
		start: [x, 0],
		heading: 0,
		walls: [
			[0, 2],
			[90, 2],
			[90, 2],
			[90, 2],
		],
	});
	const rooms = [square('left', 0), square('right', 3)];

	it('names the room whose outline holds the point', () => {
		expect(roomAt(rooms, 1, 1)).toBe('left');
		expect(roomAt(rooms, 4, 1.5)).toBe('right');
	});

	it('is undefined in the wall between them and outside', () => {
		expect(roomAt(rooms, 2.5, 1)).toBeUndefined();
		expect(roomAt(rooms, 1, -1)).toBeUndefined();
	});
});

describe('bounds', () => {
	it('is null with no points (nothing to frame)', () => {
		expect(bounds([])).toBeNull();
	});

	it('centres on the extent and spans the larger axis', () => {
		const b = bounds([
			{ x: 0, z: 0 },
			{ x: 4, z: 2 },
		])!;
		close(b.cx, 2);
		close(b.cz, 1);
		close(b.span, 4);
	});

	it('never reports a span below 1 (a single point still frames)', () => {
		const b = bounds([{ x: 3, z: 3 }])!;
		close(b.cx, 3);
		close(b.cz, 3);
		close(b.span, 1);
	});
});

describe('wallPanels', () => {
	it('is one full panel for a wall with no openings', () => {
		expect(wallPanels(4, [], 2.4)).toEqual([{ a0: 0, a1: 4, yb: 0, yt: 2.4 }]);
	});

	it('leaves piers either side, a lintel above and a sill below a window', () => {
		const win = { wall: 0, offset: 1, width: 1.5, height: 1.2, sill: 0.9 };
		expect(wallPanels(4, [win], 2.4)).toEqual([
			{ a0: 0, a1: 1, yb: 0, yt: 2.4 },
			{ a0: 1, a1: 2.5, yb: 2.1, yt: 2.4 },
			{ a0: 1, a1: 2.5, yb: 0, yt: 0.9 },
			{ a0: 2.5, a1: 4, yb: 0, yt: 2.4 },
		]);
	});

	it('leaves only a header over a full-height doorway at the wall start', () => {
		const door = { wall: 0, offset: 0, width: 2.4, height: 2.22 };
		const p = wallPanels(3.19, [door], 2.4);
		expect(p.length).toBe(2);
		expect(p[0]).toEqual({ a0: 0, a1: 2.4, yb: 2.22, yt: 2.4 });
		expect(p[1].a0).toBe(2.4);
		expect(p[1].a1).toBeCloseTo(3.19);
	});
});

describe('glazingLayout', () => {
	const win = { wall: 0, offset: 0, width: 1.4, height: 1.25, sill: 0.9 };
	const glazing = {
		frame: 0.06,
		transom: 0.92,
		upperPanes: 2,
		lower: 'frosted',
		upper: 'clear',
		frameMaterial: 'pvc',
	};

	it('frames the opening, splits it at the transom, and divides the top into panes', () => {
		const parts = glazingLayout(win, glazing);
		const panes = parts.filter((p) => p.kind !== 'frame');
		expect(panes.map((p) => p.kind)).toEqual(['lower', 'upper', 'upper']);
		const [lower, up1, up2] = panes;
		expect(lower.yb).toBeCloseTo(0.96);
		expect(lower.yt).toBeCloseTo(0.9 + 0.92 - 0.03);
		expect(up1.a1).toBeLessThan(up2.a0);
		expect(up2.a1).toBeCloseTo(1.34);
		expect(up1.yt).toBeCloseTo(2.15 - 0.06);
	});

	it('leaves no gap and no overlap: frame and panes tile the opening exactly', () => {
		const area = glazingLayout(win, glazing).reduce((s, p) => s + (p.a1 - p.a0) * (p.yt - p.yb), 0);
		expect(area).toBeCloseTo(1.4 * 1.25, 6);
	});
});

describe('passages', () => {
	// Two rooms whose facing walls stand 0.2 m apart, a 1 m doorway cut in each.
	const a = {
		name: 'a',
		start: [0, 0] as [number, number],
		walls: [
			[0, 2],
			[90, 2],
			[90, 2],
			[90, 2],
		] as [number, number][],
		openings: [{ wall: 0, offset: 0.5, width: 1, height: 2, leads: 'b' }],
	};
	const b = {
		name: 'b',
		start: [2, -0.2] as [number, number],
		heading: 180,
		walls: [
			[0, 2],
			[90, 2],
			[90, 2],
			[90, 2],
		] as [number, number][],
		openings: [{ wall: 0, offset: 0.5, width: 1, height: 2, leads: 'a' }],
	};

	it('fills the wall thickness between two matching openings once, with its four faces', () => {
		const ps = passages({ height: 2.4, rooms: [a, b], furniture: [] });
		expect(ps.length).toBe(1);
		expect(ps[0].floor.map(([x, , z]) => [+x.toFixed(3), +z.toFixed(3)]).sort()).toEqual(
			[
				[0.5, -0.2],
				[0.5, 0],
				[1.5, -0.2],
				[1.5, 0],
			].sort(),
		);
		expect(ps[0].soffit.every(([, y]) => y === 2)).toBe(true);
		expect(ps[0].jambs.length).toBe(2);
	});

	it('fills nothing for an opening to the outside', () => {
		const lone = {
			...a,
			openings: [{ wall: 0, offset: 0.5, width: 1, height: 1, sill: 1, leads: 'outside' }],
		};
		expect(passages({ height: 2.4, rooms: [lone], furniture: [] })).toEqual([]);
	});
});

describe('covingProfile', () => {
	it('runs from the wall, its drop down, to the ceiling, its depth out, bowed into the corner', () => {
		const p = covingProfile(0.08, 0.11);
		expect(p[0][0]).toBeCloseTo(0, 9);
		expect(p[0][1]).toBeCloseTo(0.08, 9);
		expect(p[p.length - 1][0]).toBeCloseTo(0.11, 9);
		expect(p[p.length - 1][1]).toBeCloseTo(0, 9);
		// Its middle is nearer the corner than the straight chamfer's.
		const [u, v] = p[Math.floor(p.length / 2)];
		expect(u / 0.11 + v / 0.08).toBeLessThan(1);
	});
});

describe('skirtingRuns', () => {
	it('runs the length of a plain wall', () => {
		expect(skirtingRuns(3, [], 2.4)).toEqual([[0, 3]]);
	});

	it('breaks at a doorway and runs on under a window', () => {
		const door = { wall: 0, offset: 1, width: 0.8, height: 2, sill: 0 };
		const window = { wall: 0, offset: 2.2, width: 0.5, height: 1, sill: 0.9 };
		expect(skirtingRuns(3, [door, window], 2.4)).toEqual([
			[0, 1],
			[1.8, 3],
		]);
	});
});

describe('inwardNormals', () => {
	// A point a little way in from each wall's middle is inside the outline.
	const inside = (pts: { x: number; z: number }[], x: number, z: number) => {
		let hit = false;
		for (let i = 0, j = pts.length - 2; i < pts.length - 1; j = i++) {
			const [a, b] = [pts[i], pts[j]];
			if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
		}
		return hit;
	};
	const check = (walls: [number, number][]) => {
		const pts = perimeter(walls);
		const n = inwardNormals(pts);
		pts.slice(0, -1).forEach((p, i) => {
			const q = pts[i + 1];
			const [mx, mz] = [(p.x + q.x) / 2 + n[i][0] * 0.01, (p.z + q.z) / 2 + n[i][1] * 0.01];
			expect(inside(pts, mx, mz)).toBe(true);
		});
	};

	it('points into a room with a chimney breast, whose centre lies behind the breast', () => {
		// The living room's outline, the breast's two short returns included.
		check([
			[0, 1.38],
			[-90, 0.35],
			[90, 1.2],
			[90, 0.81],
			[0, 3.19],
			[90, 3.9],
			[90, 4],
			[90, 1.32],
			[90, 0.35],
		]);
	});

	it('points into a room walked the other way round', () => {
		check([
			[0, 3],
			[-90, 2],
			[-90, 3],
			[-90, 2],
		]);
	});
});

describe('mitre', () => {
	it('meets at the point the same distance from both walls, inside or outside a corner', () => {
		// An inside corner, walls along x and z, the room in +x +z.
		const inside = mitre({ x: 0, z: 0 }, [0, 1], [1, 0], 0.1);
		expect([inside.x, inside.z]).toEqual([0.1, 0.1]);
		// An outside corner (a chimney breast's): the room wraps round it.
		const outside = mitre({ x: 0, z: 0 }, [0, -1], [-1, 0], 0.1);
		expect([outside.x, outside.z]).toEqual([-0.1, -0.1]);
	});

	it('runs straight on where the wall does', () => {
		const p = mitre({ x: 1, z: 0 }, [0, 1], [0, 1], 0.1);
		expect(p.x).toBeCloseTo(1, 12);
		expect(p.z).toBeCloseTo(0.1, 12);
	});
});
