// Pure geometry for the house scene — no three.js, so it's testable.
// A room is a turtle walk: from a start corner + heading, each wall turns then
// steps, producing the corner points and wall segments.

import type { Glazing, HouseScene, Room, WallOpening } from './house.model';

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

/** The room whose outline holds the point (x, z), by its name: none in a wall's
 *  thickness or outside. */
export function roomAt(rooms: Room[], x: number, z: number): string | undefined {
	for (const room of rooms) {
		const pts = roomPerimeter(room);
		let inside = false;
		for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
			const [a, b] = [pts[i], pts[j]];
			if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x)
				inside = !inside;
		}
		if (inside) return room.name;
	}
	return undefined;
}

/** The room holding the point (x, z), else the one whose outline comes closest: for
 *  a piece standing in a wall's thickness or across a room's edge. */
export function nearestRoom(rooms: Room[], x: number, z: number): string | undefined {
	const holding = roomAt(rooms, x, z);
	if (holding) return holding;
	let best: string | undefined;
	let bestD = Infinity;
	for (const room of rooms)
		for (const s of segments(roomPerimeter(room))) {
			const [dx, dz] = [s.bx - s.ax, s.bz - s.az];
			const t = Math.max(
				0,
				Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1)),
			);
			const d = Math.hypot(x - s.ax - t * dx, z - s.az - t * dz);
			if (d < bestD) [best, bestD] = [room.name, d];
		}
	return best;
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

/** One rectangle of a window, in the same coordinates as a WallPanel. */
export interface GlazingPart extends WallPanel {
	kind: 'frame' | 'lower' | 'upper';
}

/** A window's frame and panes in its opening: the frame round the edge, a transom
 *  bar `transom` above the sill, the lower pane under it and `upperPanes` panes
 *  over it, split by mullions. Together they tile the opening exactly. */
export function glazingLayout(o: WallOpening, g: Glazing): GlazingPart[] {
	const f = g.frame;
	const a0 = o.offset;
	const a1 = o.offset + o.width;
	const y0 = o.sill ?? 0;
	const y1 = y0 + o.height;
	const out: GlazingPart[] = [
		{ kind: 'frame', a0, a1: a0 + f, yb: y0, yt: y1 },
		{ kind: 'frame', a0: a1 - f, a1, yb: y0, yt: y1 },
		{ kind: 'frame', a0: a0 + f, a1: a1 - f, yb: y0, yt: y0 + f },
		{ kind: 'frame', a0: a0 + f, a1: a1 - f, yb: y1 - f, yt: y1 },
	];
	const ia0 = a0 + f;
	const ia1 = a1 - f;
	if (g.transom === undefined) {
		out.push({ kind: 'lower', a0: ia0, a1: ia1, yb: y0 + f, yt: y1 - f });
		return out;
	}
	const t = y0 + g.transom;
	out.push({ kind: 'frame', a0: ia0, a1: ia1, yb: t - f / 2, yt: t + f / 2 });
	out.push({ kind: 'lower', a0: ia0, a1: ia1, yb: y0 + f, yt: t - f / 2 });
	const n = Math.max(1, g.upperPanes ?? 1);
	const pane = (ia1 - ia0 - (n - 1) * f) / n;
	for (let k = 0; k < n; k++) {
		const pa0 = ia0 + k * (pane + f);
		out.push({ kind: 'upper', a0: pa0, a1: pa0 + pane, yb: t + f / 2, yt: y1 - f });
		if (k < n - 1)
			out.push({ kind: 'frame', a0: pa0 + pane, a1: pa0 + pane + f, yb: t + f / 2, yt: y1 - f });
	}
	return out;
}

export type P3 = [number, number, number];

/** The wall thickness at a doorway between two rooms: each room is its own outline,
 *  so the two walls stand apart and the gap between their openings must be filled
 *  with a floor, a soffit above and the two side jambs. */
export interface Passage {
	/** The room whose surfaces it takes. */
	room: Room;
	floor: P3[];
	soffit: P3[];
	jambs: P3[][];
}

/** How far apart two facing walls may stand and still be one wall's two faces. */
const WALL_THICKNESS_MAX = 0.5;

function openingEnds(
	room: Room,
	o: WallOpening,
): { a: [number, number]; b: [number, number]; seg: WallSeg } | null {
	const seg = segments(roomPerimeter(room))[o.wall];
	if (!seg) return null;
	const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
	const ux = (seg.bx - seg.ax) / len;
	const uz = (seg.bz - seg.az) / len;
	return {
		a: [seg.ax + ux * o.offset, seg.az + uz * o.offset],
		b: [seg.ax + ux * (o.offset + o.width), seg.az + uz * (o.offset + o.width)],
		seg,
	};
}

export function passages(scene: HouseScene): Passage[] {
	const out: Passage[] = [];
	scene.rooms.forEach((room, ri) => {
		for (const o of room.openings ?? []) {
			const j = scene.rooms.findIndex((r) => r.name === o.leads);
			if (j <= ri) continue; // each pair once; outside leads to no room
			const other = scene.rooms[j];
			const here = openingEnds(room, o);
			if (!here) continue;
			for (const o2 of other.openings ?? []) {
				if (o2.leads !== room.name) continue;
				const there = openingEnds(other, o2);
				if (!there) continue;
				// The far opening's ends, each matched to the nearer end here.
				const d = (p: [number, number], q: [number, number]) =>
					Math.hypot(p[0] - q[0], p[1] - q[1]);
				const [qa, qb] =
					d(here.a, there.a) <= d(here.a, there.b) ? [there.a, there.b] : [there.b, there.a];
				if (d(here.a, qa) > WALL_THICKNESS_MAX || d(here.b, qb) > WALL_THICKNESS_MAX) continue;
				const yb = Math.max(o.sill ?? 0, o2.sill ?? 0);
				const yt = Math.min((o.sill ?? 0) + o.height, (o2.sill ?? 0) + o2.height);
				const at = (p: [number, number], y: number): P3 => [p[0], y, p[1]];
				out.push({
					room,
					floor: [at(here.a, yb), at(here.b, yb), at(qb, yb), at(qa, yb)],
					soffit: [at(here.a, yt), at(here.b, yt), at(qb, yt), at(qa, yt)],
					jambs: [
						[at(here.a, yb), at(qa, yb), at(qa, yt), at(here.a, yt)],
						[at(here.b, yb), at(qb, yb), at(qb, yt), at(here.b, yt)],
					],
				});
			}
		}
	});
	return out;
}

/** A coving's profile, wall to ceiling: points [across the ceiling from the wall,
 *  down from the ceiling], a quarter ellipse bowed into the corner. */
export function covingProfile(drop: number, depth: number, steps = 8): [number, number][] {
	return Array.from({ length: steps + 1 }, (_, k) => {
		const t = ((k / steps) * Math.PI) / 2;
		return [depth * (1 - Math.cos(t)), drop * (1 - Math.sin(t))];
	});
}

/** Where a wall's skirting runs, as spans along it: wherever the wall reaches the
 *  floor, so under a window but not across a doorway. */
export function skirtingRuns(len: number, ops: WallOpening[], h: number): [number, number][] {
	const runs: [number, number][] = [];
	const low = wallPanels(len, ops, h)
		.filter((p) => p.yb <= 1e-6)
		.sort((p, q) => p.a0 - q.a0);
	for (const p of low) {
		const last = runs[runs.length - 1];
		if (last && p.a0 <= last[1] + 1e-6) last[1] = Math.max(last[1], p.a1);
		else runs.push([p.a0, p.a1]);
	}
	return runs;
}

/** Into the room from each of its walls, as unit [x, z]: the inside of an outline
 *  is on the same hand all the way round (left if it runs anticlockwise, by its
 *  signed area), whatever its shape. A room with a chimney breast is not convex,
 *  so its centre can lie behind a wall. */
export function inwardNormals(pts: Pt[]): [number, number][] {
	let area = 0;
	for (let i = 0; i < pts.length - 1; i++)
		area += pts[i].x * pts[i + 1].z - pts[i + 1].x * pts[i].z;
	const left = area > 0 ? 1 : -1;
	return segments(pts).map((s) => {
		const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1;
		return [(left * -(s.bz - s.az)) / len, (left * (s.bx - s.ax)) / len];
	});
}

/** Where a strip `u` metres out from two walls meets itself at their corner: the
 *  point that far from both, as a mitred moulding's cut is. `n1`, `n2` are the
 *  walls' inward normals; an outside corner and an inside one alike. */
export function mitre(corner: Pt, n1: [number, number], n2: [number, number], u: number): Pt {
	const c = n1[0] * n2[0] + n1[1] * n2[1];
	// Walls doubling back on themselves have no meeting point: keep the square end.
	if (c < -0.999) return { x: corner.x + n1[0] * u, z: corner.z + n1[1] * u };
	const k = u / (1 + c);
	return { x: corner.x + (n1[0] + n2[0]) * k, z: corner.z + (n1[1] + n2[1]) * k };
}
