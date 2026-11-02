// Pure geometry for the house scene — no three.js, so it's testable.
// A room is a turtle walk: from a start corner + heading, each wall turns then
// steps, producing the corner points and wall segments.

import type { Room, WallOpening } from './house.model';

export interface Pt {
	x: number;
	z: number;
}

export interface WallSeg {
	ax: number;
	az: number;
	bx: number;
	bz: number;
}

/** Corner points of a room's outline. Starts at `start` heading `heading0`
 *  degrees; each wall is `[turn_deg, length_m]` — turn the heading, then step. */
export function perimeter(
	walls: [number, number][],
	start: Pt = { x: 0, z: 0 },
	heading0 = 0,
): Pt[] {
	const pts: Pt[] = [{ x: start.x, z: start.z }];
	let x = start.x;
	let z = start.z;
	let heading = heading0;
	for (const [turn, len] of walls) {
		heading += turn;
		const r = (heading * Math.PI) / 180;
		x += len * Math.cos(r);
		z += len * Math.sin(r);
		pts.push({ x, z });
	}
	return pts;
}

/** A room's corner points, from its start/heading. */
export function roomPerimeter(room: Room): Pt[] {
	return perimeter(room.walls, { x: room.start[0], z: room.start[1] }, room.heading ?? 0);
}

/** Consecutive wall segments from a list of perimeter points. */
export function segments(pts: Pt[]): WallSeg[] {
	const segs: WallSeg[] = [];
	for (let i = 0; i < pts.length - 1; i++) {
		segs.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z });
	}
	return segs;
}

/** Axis-aligned XZ bounds over a set of points (all rooms), for camera framing. */
export function bounds(pts: Pt[]): { cx: number; cz: number; span: number } | null {
	if (pts.length === 0) return null;
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const p of pts) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minZ = Math.min(minZ, p.z);
		maxZ = Math.max(maxZ, p.z);
	}
	return {
		cx: (minX + maxX) / 2,
		cz: (minZ + maxZ) / 2,
		span: Math.max(maxX - minX, maxZ - minZ, 1),
	};
}

/** One solid rectangle of a wall: [a0,a1] metres along it from its start, [yb,yt] up. */
export interface WallPanel {
	a0: number;
	a1: number;
	yb: number;
	yt: number;
}

/** A wall of length `len` and height `h`, cut by its openings: solid piers
 *  between and around them, a lintel above each and a sill below a window. A
 *  floor-to-ceiling opening therefore leaves only its header. */
export function wallPanels(len: number, ops: WallOpening[], h: number): WallPanel[] {
	const cuts = ops
		.map((o) => ({
			a0: o.offset,
			a1: o.offset + o.width,
			yb: o.sill ?? 0,
			yt: (o.sill ?? 0) + o.height,
		}))
		.sort((p, q) => p.a0 - q.a0);
	const out: WallPanel[] = [];
	const push = (a0: number, a1: number, yb: number, yt: number) => {
		if (a1 - a0 > 1e-6 && yt - yb > 1e-6) out.push({ a0, a1, yb, yt });
	};
	let cursor = 0;
	for (const c of cuts) {
		const a0 = Math.max(0, Math.min(len, c.a0));
		const a1 = Math.max(0, Math.min(len, c.a1));
		if (a0 > cursor) push(cursor, a0, 0, h);
		if (c.yt < h) push(a0, a1, c.yt, h);
		if (c.yb > 0) push(a0, a1, 0, c.yb);
		cursor = Math.max(cursor, a1);
	}
	if (cursor < len) push(cursor, len, 0, h);
	return out;
}
