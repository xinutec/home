import type { Furniture, Joint, Part } from './house.model';

/**
 * Where a piece's parts are in the room, for a given state of its joints.
 *
 * Every rotation here is about the vertical, so a placed part is a box turned
 * about y: a rectangle on the floor plane plus a height range. That is all the
 * house needs (doors swing, drawers slide) and keeps the checks exact.
 */

/** A placed part: centre (x, z), half width and depth along its own axes, turned
 *  `yaw` radians about +y, spanning y0..y1. */
export interface Solid {
	piece: string;
	part: string;
	x: number;
	z: number;
	yaw: number;
	hw: number;
	hd: number;
	y0: number;
	y1: number;
}

/** Joint values by `piece/part`, metres or degrees; absent is closed (range[0]). */
export type JointState = Record<string, number>;

/** A rigid move turning about +y by `yaw`, then shifting by (tx, ty, tz). */
interface Move {
	c: number;
	s: number;
	tx: number;
	ty: number;
	tz: number;
}

const STILL: Move = { c: 1, s: 0, tx: 0, ty: 0, tz: 0 };

/** three.js's sense: positive yaw is anticlockwise seen from above. */
function apply(m: Move, x: number, y: number, z: number): [number, number, number] {
	return [x * m.c + z * m.s + m.tx, y + m.ty, -x * m.s + z * m.c + m.tz];
}

/** `outer` after `inner`. */
function then(inner: Move, outer: Move): Move {
	const [tx, ty, tz] = apply(outer, inner.tx, inner.ty, inner.tz);
	return {
		c: inner.c * outer.c - inner.s * outer.s,
		s: inner.s * outer.c + inner.c * outer.s,
		tx,
		ty,
		tz,
	};
}

function jointMove(j: Joint, v: number): Move {
	if (j.type === 'slide')
		return { c: 1, s: 0, tx: j.axis[0] * v, ty: j.axis[1] * v, tz: j.axis[2] * v };
	const a = (v * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const [px, , pz] = j.pivot;
	// Turn about the vertical through the pivot: shift it to the origin, turn, shift back.
	return { c, s, tx: px - px * c - pz * s, ty: 0, tz: pz + px * s - pz * c };
}

const FRONT_YAW: Record<NonNullable<Furniture['front']>, number> = {
	'+z': 0,
	'+x': Math.PI / 2,
	'-z': Math.PI,
	'-x': -Math.PI / 2,
};

/** The piece's frame in the room: origin at its envelope's floor centre, front +z. */
function pieceMove(f: Furniture): Move {
	const a = FRONT_YAW[f.front ?? '+z'];
	return { c: Math.cos(a), s: Math.sin(a), tx: f.cx, ty: f.y0 ?? 0, tz: f.cz };
}

/** A piece with no parts is one part filling its envelope. */
export function partsOf(f: Furniture): Part[] {
	if (f.parts && f.parts.length > 0) return f.parts;
	const swap = f.front === '+x' || f.front === '-x';
	return [{ id: 'body', size: swap ? [f.d, f.h, f.w] : [f.w, f.h, f.d], at: [0, f.h / 2, 0] }];
}

/** A piece's name in messages: its id, or for one without, where it stands,
 *  which survives another piece being added or removed before it. */
export function pieceId(f: Furniture): string {
	return f.id ?? `@${f.cx},${f.cz},${f.y0 ?? 0}`;
}

/** A part's motion in its piece's frame: its own joint, then each parent's. */
function motion(parts: Part[], part: Part, key: (p: Part) => string, state: JointState): Move {
	let m = STILL;
	const seen = new Set<string>();
	for (let p: Part | undefined = part; p; p = parts.find((q) => q.id === p?.parent)) {
		if (seen.has(p.id)) throw new Error(`part ${p.id} is its own ancestor`);
		seen.add(p.id);
		if (p.joint) m = then(m, jointMove(p.joint, state[key(p)] ?? p.joint.range[0]));
	}
	return m;
}

/** Every part of a piece, placed in the room. */
export function solidsOf(f: Furniture, state: JointState = {}): Solid[] {
	const piece = pieceId(f);
	const parts = partsOf(f);
	const frame = pieceMove(f);
	const key = (p: Part) => `${piece}/${p.id}`;
	return parts.map((p) => {
		const m = then(motion(parts, p, key, state), frame);
		const [x, y, z] = apply(m, p.at[0], p.at[1], p.at[2]);
		return {
			piece,
			part: p.id,
			x,
			z,
			yaw: Math.atan2(m.s, m.c),
			hw: p.size[0] / 2,
			hd: p.size[2] / 2,
			y0: y - p.size[1] / 2,
			y1: y + p.size[1] / 2,
		};
	});
}

/** The four floor-plane corners of a solid. */
export function corners(s: Solid): [number, number][] {
	const c = Math.cos(s.yaw);
	const n = Math.sin(s.yaw);
	return [
		[-s.hw, -s.hd],
		[s.hw, -s.hd],
		[s.hw, s.hd],
		[-s.hw, s.hd],
	].map(([u, v]) => [s.x + u * c + v * n, s.z - u * n + v * c]);
}
