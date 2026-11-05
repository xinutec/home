import * as THREE from 'three';
import { houseBodies } from './collisions';
import type { HouseBody } from './collisions';
import { nearest, surfacePoints } from './contact';

/** Metres between two surfaces that still count as touching: resting, hung, fixed. */
export const CONTACT = 0.003;
/** Metres between the points sampled where a piece meets what holds it: a footing's
 *  outline needs no finer, and the smallest contact (a radiator bracket, 4 × 3.5 cm)
 *  still gets points. */
const SAMPLE_SPACING = 0.02;

/** A piece nothing holds, and what is wrong. */
export interface Unheld {
	piece: string;
	why: string;
}

/** How a piece touches what is near it, for holding. */
type Touch = 'on' | 'under' | 'against';

/**
 * Every piece of the drawn house that nothing holds, by contact on the real shapes:
 * a piece is held if it touches a wall (fixed to it: a TV, a radiator), hangs from
 * a surface facing down over it (a light from the ceiling, a curtain from its pole),
 * or rests on surfaces facing up under it (the floor, a table) with its centre of
 * mass over where it rests (inside the outline of those points, seen from above);
 * a soft piece (a bean bag) settles onto whatever it rests on. What holds it must
 * be held itself, so this works up from the floor and walls.
 * `meshes` are `buildHouse`'s.
 */
// dev-lint: allow-ts-test-only the physics runs ahead of time, in the gate, on the real scene (scene-physics.spec.ts); the page needs none of it
export function unsupported(meshes: THREE.Mesh[]): Unheld[] {
	const bodies = houseBodies(meshes);
	const pieces = new Map<string, HouseBody[]>();
	for (const b of bodies)
		if (b.tag.kind === 'part') pieces.set(b.tag.piece, [...(pieces.get(b.tag.piece) ?? []), b]);
	// What can hold: anything with an inside (not a curtain's folds, not leaves).
	const holders = bodies.filter((b) => b.body.hasInside);
	// Every contact, measured once; which hold is decided as the held set grows.
	const contacts = new Map<string, Contact[]>();
	for (const [piece, parts] of pieces)
		contacts.set(
			piece,
			touches(
				parts,
				holders.filter((b) => !(b.tag.kind === 'part' && b.tag.piece === piece)),
			),
		);

	const held = new Set<string>();
	const holds = (c: Contact) => c.by === undefined || held.has(c.by);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [piece, parts] of pieces) {
			if (held.has(piece)) continue;
			const mine = (contacts.get(piece) ?? []).filter(holds);
			const footing = mine.filter((c) => c.how === 'on').map((c) => c.at);
			const soft = parts.some((b) => b.tag.kind === 'part' && b.tag.soft);
			if (
				mine.some((c) => c.how !== 'on') ||
				(footing.length && (soft || over(centreOfMass(parts), footing)))
			) {
				held.add(piece);
				grew = true;
			}
		}
	}

	const out: Unheld[] = [];
	for (const piece of pieces.keys()) {
		if (held.has(piece)) continue;
		const resting = (contacts.get(piece) ?? []).some((c) => c.how === 'on' && holds(c));
		const why = resting
			? 'its centre of mass is not over where it rests'
			: 'it rests on, hangs from and is fixed to nothing that is held';
		out.push({ piece, why });
	}
	return out;
}

/** A point of a piece touching something: on a surface facing up, under one facing
 *  down, or against a wall; `by`, the piece touched, or undefined for the house. */
interface Contact {
	at: THREE.Vector3;
	how: Touch;
	by?: string;
}

/** Where `parts`' surfaces touch `holders`' (within CONTACT), and how. */
function touches(parts: HouseBody[], holders: HouseBody[]): Contact[] {
	const out: Contact[] = [];
	for (const part of parts)
		for (const other of holders) {
			const within = part.body.box
				.clone()
				.intersect(other.body.box.clone().expandByScalar(CONTACT));
			if (within.isEmpty()) continue;
			const by = other.tag.kind === 'part' ? other.tag.piece : undefined;
			for (const p of surfacePoints(part.body, within.expandByScalar(CONTACT), SAMPLE_SPACING)) {
				const n = nearest(other.body, p);
				if (!n || n.distance > CONTACT) continue;
				if (n.normal.y >= 0.5) out.push({ at: p, how: 'on', by });
				else if (n.normal.y <= -0.5) out.push({ at: p, how: 'under', by });
				else if (other.tag.kind === 'wall') out.push({ at: p, how: 'against' });
			}
		}
	return out;
}

/** A piece's centre of mass, as if of one density: each part's bounds' centre,
 *  weighted by their volume (a sheet's, near none, by its area a centimetre thick). */
function centreOfMass(parts: HouseBody[]): THREE.Vector3 {
	const sum = new THREE.Vector3();
	let mass = 0;
	for (const p of parts) {
		const s = p.body.box.getSize(new THREE.Vector3());
		const m = Math.max(s.x, 0.01) * Math.max(s.y, 0.01) * Math.max(s.z, 0.01);
		sum.addScaledVector(p.body.box.getCenter(new THREE.Vector3()), m);
		mass += m;
	}
	return sum.divideScalar(mass || 1);
}

/** Whether `c`, seen from above, lies inside the outline of `points` (or within
 *  CONTACT of it: a piece with one edge resting is on its edge). */
function over(c: THREE.Vector3, points: THREE.Vector3[]): boolean {
	const hull = convexHull(points.map((p) => [p.x, p.z] as [number, number]));
	if (hull.length < 3) return hull.some(([x, z]) => Math.hypot(x - c.x, z - c.z) <= CONTACT);
	for (let i = 0; i < hull.length; i++) {
		const [ax, az] = hull[i];
		const [bx, bz] = hull[(i + 1) % hull.length];
		const len = Math.hypot(bx - ax, bz - az) || 1;
		// Anticlockwise: the inside is on the left of each side.
		const left = ((bx - ax) * (c.z - az) - (bz - az) * (c.x - ax)) / len;
		if (left < -CONTACT) return false;
	}
	return true;
}

/** The convex hull of 2D points, anticlockwise (Andrew's monotone chain). */
export function convexHull(points: [number, number][]): [number, number][] {
	const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (pts.length < 3) return pts;
	const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: [number, number][] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
			lower.pop();
		lower.push(p);
	}
	const upper: [number, number][] = [];
	for (const p of [...pts].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
			upper.pop();
		upper.push(p);
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
