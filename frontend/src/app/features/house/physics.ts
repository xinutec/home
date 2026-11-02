import { corners, partsOf, pieceId, solidsOf } from './assembly';
import type { JointState, Solid } from './assembly';
import type { HouseScene, Part } from './house.model';
import { roomPerimeter, segments, wallPanels } from './scene-geometry';

/**
 * What the house must never do, checked on the scene itself: two solids in the
 * same place, a part through a wall, a moving part hitting anything anywhere
 * along its travel, a part outside its piece's envelope, a piece held up by
 * nothing, a joint whose range does not start closed.
 *
 * Touching is allowed: a sideboard stands against its wall, a knob on its
 * drawer. Only a penetration deeper than TOLERANCE counts.
 */
export const TOLERANCE = 0.002; // metres

export interface Violation {
	kind: 'overlap' | 'wall' | 'sweep' | 'envelope' | 'support' | 'joint';
	what: string;
}

/** How deep two solids interpenetrate; 0 when they only touch or are apart. */
export function penetration(a: Solid, b: Solid): number {
	const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
	if (dy <= TOLERANCE) return 0;
	const ca = corners(a);
	const cb = corners(b);
	let depth = dy;
	// Separating axes: the two edge directions of each rectangle.
	for (const s of [a, b]) {
		for (const [ux, uz] of [
			[Math.cos(s.yaw), -Math.sin(s.yaw)],
			[Math.sin(s.yaw), Math.cos(s.yaw)],
		]) {
			const pa = ca.map(([x, z]) => x * ux + z * uz);
			const pb = cb.map(([x, z]) => x * ux + z * uz);
			const o =
				Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
			if (o <= TOLERANCE) return 0;
			depth = Math.min(depth, o);
		}
	}
	return depth;
}

interface WallPiece {
	ax: number;
	az: number;
	bx: number;
	bz: number;
	len: number;
	y0: number;
	y1: number;
	name: string;
}

/** Every solid piece of wall: the wall segments cut by their openings. */
function walls(scene: HouseScene): WallPiece[] {
	const out: WallPiece[] = [];
	for (const room of scene.rooms) {
		segments(roomPerimeter(room)).forEach((s, i) => {
			const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
			if (len < 1e-6) return;
			const ops = (room.openings ?? []).filter((o) => o.wall === i);
			for (const p of wallPanels(len, ops, scene.height)) {
				const ux = (s.bx - s.ax) / len;
				const uz = (s.bz - s.az) / len;
				out.push({
					ax: s.ax + ux * p.a0,
					az: s.az + uz * p.a0,
					bx: s.ax + ux * p.a1,
					bz: s.az + uz * p.a1,
					len: p.a1 - p.a0,
					y0: p.yb,
					y1: p.yt,
					name: `${room.name ?? 'room'} wall ${i}`,
				});
			}
		});
	}
	return out;
}

/** Whether a solid passes through a piece of wall (not merely touching it). */
function throughWall(s: Solid, w: WallPiece): boolean {
	if (Math.min(s.y1, w.y1) - Math.max(s.y0, w.y0) <= TOLERANCE) return false;
	const ux = (w.bx - w.ax) / w.len;
	const uz = (w.bz - w.az) / w.len;
	const along = corners(s).map(([x, z]) => (x - w.ax) * ux + (z - w.az) * uz);
	const across = corners(s).map(([x, z]) => -(x - w.ax) * uz + (z - w.az) * ux);
	const inSpan = Math.min(Math.max(...along), w.len) - Math.max(Math.min(...along), 0) > TOLERANCE;
	return inSpan && Math.min(...across) < -TOLERANCE && Math.max(...across) > TOLERANCE;
}

const label = (s: Solid) => `${s.piece}/${s.part}`;

function collisions(moving: Solid[], fixed: Solid[], ws: WallPiece[]): string[] {
	const out: string[] = [];
	for (const m of moving) {
		for (const f of fixed) {
			const d = penetration(m, f);
			if (d > 0) out.push(`${label(m)} into ${label(f)} by ${(d * 1000).toFixed(0)} mm`);
		}
		for (const w of ws) if (throughWall(m, w)) out.push(`${label(m)} through ${w.name}`);
	}
	return out;
}

/** The part and everything fixed to it, by id. */
function withChildren(parts: Part[], id: string): Set<string> {
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const p of parts) {
			if (p.parent && out.has(p.parent) && !out.has(p.id)) {
				out.add(p.id);
				grew = true;
			}
		}
	}
	return out;
}

/** Samples along each joint's travel, ends included. */
const SWEEP_STEPS = 12;

export function check(scene: HouseScene): Violation[] {
	const out: Violation[] = [];
	const ws = walls(scene);
	const all = scene.furniture.flatMap((f) => solidsOf(f));

	// At rest: no two solids in one place, nothing through a wall.
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const d = penetration(all[i], all[j]);
			if (d > 0)
				out.push({
					kind: 'overlap',
					what: `${label(all[i])} and ${label(all[j])} overlap by ${(d * 1000).toFixed(0)} mm`,
				});
		}
		for (const w of ws)
			if (throughWall(all[i], w))
				out.push({ kind: 'wall', what: `${label(all[i])} through ${w.name}` });
	}

	scene.furniture.forEach((f) => {
		const piece = pieceId(f);
		const parts = partsOf(f);

		// Closed, every part sits inside the piece's envelope.
		const x0 = f.cx - f.w / 2;
		const x1 = f.cx + f.w / 2;
		const z0 = f.cz - f.d / 2;
		const z1 = f.cz + f.d / 2;
		const ey0 = f.y0 ?? 0;
		for (const s of solidsOf(f)) {
			const cs = corners(s);
			const outside =
				cs.some(
					([x, z]) =>
						x < x0 - TOLERANCE || x > x1 + TOLERANCE || z < z0 - TOLERANCE || z > z1 + TOLERANCE,
				) ||
				s.y0 < ey0 - TOLERANCE ||
				s.y1 > ey0 + f.h + TOLERANCE;
			if (outside) out.push({ kind: 'envelope', what: `${label(s)} sticks out of ${piece}'s box` });
		}

		// Along its travel, a moving part (and what is fixed to it) hits nothing.
		for (const p of parts) {
			if (!p.joint) continue;
			const [r0, r1] = p.joint.range;
			if (r0 !== 0)
				out.push({ kind: 'joint', what: `${piece}/${p.id} range starts at ${r0}, not closed (0)` });
			const moved = withChildren(parts, p.id);
			const others = all.filter((s) => !(s.piece === piece && moved.has(s.part)));
			const hits = new Set<string>();
			for (let k = 1; k <= SWEEP_STEPS; k++) {
				const v = r0 + ((r1 - r0) * k) / SWEEP_STEPS;
				const state: JointState = { [`${piece}/${p.id}`]: v };
				const moving = solidsOf(f, state).filter((s) => moved.has(s.part));
				for (const h of collisions(moving, others, ws)) hits.add(h);
			}
			for (const h of hits) out.push({ kind: 'sweep', what: `opening ${piece}/${p.id}: ${h}` });
		}
	});

	// Held up: by the floor, by a piece it stands on, or by a wall it is fixed to.
	scene.furniture.forEach((f, i) => {
		const y0 = f.y0 ?? 0;
		if (y0 <= TOLERANCE) return;
		const env = envelopeSolid(f, i);
		const below = scene.furniture.some((g, j) => {
			if (j === i) return false;
			const top = (g.y0 ?? 0) + g.h;
			return Math.abs(top - y0) <= TOLERANCE && footprintsOverlap(env, envelopeSolid(g, j));
		});
		const onWall = ws.some((w) => touchesWall(env, w));
		if (!below && !onWall)
			out.push({
				kind: 'support',
				what: `${pieceId(f)} is held up by nothing (bottom at ${y0} m)`,
			});
	});
	// One wall cut by openings is several panels; say each finding once.
	const seen = new Set<string>();
	return out.filter((v) => !seen.has(v.what) && seen.add(v.what));
}

function envelopeSolid(
	f: { cx: number; cz: number; w: number; d: number; h: number; y0?: number },
	i: number,
): Solid {
	return {
		piece: `#${i}`,
		part: 'envelope',
		x: f.cx,
		z: f.cz,
		yaw: 0,
		hw: f.w / 2,
		hd: f.d / 2,
		y0: f.y0 ?? 0,
		y1: (f.y0 ?? 0) + f.h,
	};
}

function footprintsOverlap(a: Solid, b: Solid): boolean {
	return penetration({ ...a, y0: 0, y1: 1 }, { ...b, y0: 0, y1: 1 }) > 0;
}

function touchesWall(s: Solid, w: WallPiece): boolean {
	if (Math.min(s.y1, w.y1) - Math.max(s.y0, w.y0) <= TOLERANCE) return false;
	const ux = (w.bx - w.ax) / w.len;
	const uz = (w.bz - w.az) / w.len;
	return corners(s).some(([x, z]) => {
		const along = (x - w.ax) * ux + (z - w.az) * uz;
		const across = -(x - w.ax) * uz + (z - w.az) * ux;
		return along > -TOLERANCE && along < w.len + TOLERANCE && Math.abs(across) <= TOLERANCE;
	});
}
