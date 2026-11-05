import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Contact between the shapes the house is drawn with, exactly: the triangles the
 * page draws, not a box around them. A body is one mesh in the room's coordinates,
 * with a BVH for nearest-point queries.
 *
 * How deep two bodies go into each other is read off their surfaces: points sampled
 * over each where their bounds meet, a third of the thinner body's thickness apart;
 * a point is inside the other body when it lies behind the other's surface at its
 * nearest point, by that surface's outward normal (for a one-sided room surface, the
 * side it faces into its room). The deepest point, either way, is the penetration:
 * one way alone misses a board buried in a box, its faces level with the box's.
 * Sampling the surfaces, not only corners, finds boards crossed like a plus sign.
 */
export interface Body {
	name: string;
	geometry: THREE.BufferGeometry;
	bvh: MeshBVH;
	box: THREE.Box3;
	/** The way a one-sided surface faces (a wall into its room); absent, its own normals. */
	facing?: THREE.Vector3;
	/** Whether anything can be inside it: a closed solid, or a one-sided room surface;
	 *  an open sheet (a curtain) has no inside, though it can be inside something. */
	hasInside: boolean;
}

/** How far behind a one-sided room surface its inside runs: a wall's thickness,
 *  which the scene does not hold; the thinnest the rooms' outlines leave between
 *  them (the living room's and the dining room's, 13 cm). Further behind is the next
 *  room, not the wall. */
export const WALL_THICKNESS = 0.13;

/** Metres between sampled points on a surface, at most and at least. */
const SPACING_MAX = 0.015;
const SPACING_MIN = 0.003;

/** A body from a mesh in place: its geometry in the room's coordinates. */
export function bodyOf(name: string, mesh: THREE.Mesh, hasInside = true): Body {
	mesh.updateMatrixWorld(true);
	const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
	const geometry = g.index ? g : withIndex(g);
	const bvh = new MeshBVH(geometry);
	geometry.computeBoundingBox();
	const box = geometry.boundingBox ?? new THREE.Box3();
	const facing: unknown = mesh.userData['facing'];
	return {
		name,
		geometry,
		bvh,
		box,
		hasInside,
		...(facing instanceof THREE.Vector3 ? { facing: facing.clone() } : {}),
	};
}

function withIndex(g: THREE.BufferGeometry): THREE.BufferGeometry {
	const n = g.getAttribute('position').count;
	g.setIndex(Array.from({ length: n }, (_, i) => i));
	return g;
}

/** Points over a body's surface, about `spacing` apart, inside `within`: each
 *  triangle halved across its longest side until no side is longer than `spacing`,
 *  only where it meets `within` (a floor's two triangles are not gridded over the
 *  whole room for a table leg's footprint), the corners and middle of each piece kept.
 *  Halving the longest side keeps a long thin triangle's pieces `spacing` across both
 *  ways, where splitting all three sides would cut its short side far finer. */
export function surfacePoints(b: Body, within: THREE.Box3, spacing: number): THREE.Vector3[] {
	const pos = b.geometry.getAttribute('position');
	const index = b.geometry.index;
	const out: THREE.Vector3[] = [];
	const tri = new THREE.Box3();
	const split = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3): void => {
		tri.setFromPoints([p, q, r]);
		if (!tri.intersectsBox(within)) return;
		if (Math.max(p.distanceTo(q), q.distanceTo(r), r.distanceTo(p)) <= spacing) {
			for (const v of [p, q, r, new THREE.Vector3().add(p).add(q).add(r).divideScalar(3)])
				if (within.containsPoint(v)) out.push(v);
			return;
		}
		// Rotate so p→q is the longest side, then halve it.
		const [ab, bc, ca] = [p.distanceTo(q), q.distanceTo(r), r.distanceTo(p)];
		const [a, c, e] = ab >= bc && ab >= ca ? [p, q, r] : bc >= ca ? [q, r, p] : [r, p, q];
		const mid = a.clone().lerp(c, 0.5);
		split(a, mid, e);
		split(mid, c, e);
	};
	const count = index ? index.count / 3 : pos.count / 3;
	for (let t = 0; t < count; t++) {
		const [i, j, k] = [0, 1, 2].map((c) => (index ? index.getX(3 * t + c) : 3 * t + c));
		split(
			new THREE.Vector3().fromBufferAttribute(pos, i),
			new THREE.Vector3().fromBufferAttribute(pos, j),
			new THREE.Vector3().fromBufferAttribute(pos, k),
		);
	}
	return out;
}

/** How far `point` lies inside `b`: behind its surface at the nearest point, by its
 *  outward normal there, measured to that point; 0 outside or level with it. */
export function depthInside(b: Body, point: THREE.Vector3): number {
	if (!b.hasInside) return 0;
	const hit = b.bvh.closestPointToPoint(point);
	if (!hit) return 0;
	const away = point.clone().sub(hit.point);
	const d = away.length();
	if (d === 0) return 0;
	const n = faceNormal(b, hit.faceIndex);
	if (b.facing && n.dot(b.facing) < 0) n.negate();
	// Straight behind a face: a point inside a solid is nearest the inside of a face,
	// never an edge, and one off a one-sided surface's end is not behind it.
	if (-away.dot(n) < d * 0.999) return 0;
	// In a wall, as deep as its nearer face; past its far face, in the next room.
	if (b.facing) return d > WALL_THICKNESS ? 0 : Math.min(d, WALL_THICKNESS - d);
	return d;
}

function faceNormal(b: Body, face: number): THREE.Vector3 {
	const pos = b.geometry.getAttribute('position');
	const index = b.geometry.index;
	const [i, j, k] = [0, 1, 2].map((c) => (index ? index.getX(3 * face + c) : 3 * face + c));
	const p = new THREE.Vector3().fromBufferAttribute(pos, i);
	const q = new THREE.Vector3().fromBufferAttribute(pos, j);
	const r = new THREE.Vector3().fromBufferAttribute(pos, k);
	return new THREE.Triangle(p, q, r).getNormal(new THREE.Vector3());
}

/** How deep two bodies go into each other, beyond `tolerance`: the deepest point of
 *  either's surface inside the other; 0 if none is deeper than `tolerance`. */
export function penetration(a: Body, b: Body, tolerance = 0): number {
	const spacing = Math.min(
		SPACING_MAX,
		Math.max(SPACING_MIN, Math.min(thinnest(a), thinnest(b)) / 3),
	);
	let deepest = 0;
	for (const [from, into] of [
		[a, b],
		[b, a],
	] as const) {
		const within = from.box.clone().intersect(deepRegion(into, tolerance));
		if (within.isEmpty()) continue;
		for (const pt of surfacePoints(from, within, spacing))
			deepest = Math.max(deepest, depthInside(into, pt));
	}
	return deepest > tolerance ? deepest : 0;
}

/** Where a point can be more than `tolerance` inside `b`: a ball that deep around it
 *  fits in `b`, so in `b`'s bounds shrunk by `tolerance`. A one-sided surface's
 *  inside is its wall behind it: its bounds run WALL_THICKNESS back that way, and
 *  shrink along it (a corner's end is not the wall beyond the corner). */
function deepRegion(b: Body, tolerance: number): THREE.Box3 {
	if (!b.hasInside) return new THREE.Box3();
	const r = b.box.clone().expandByScalar(-tolerance);
	const f = b.facing;
	if (!f) return r;
	for (const axis of ['x', 'y', 'z'] as const) {
		if (f[axis] > 0.5)
			[r.min[axis], r.max[axis]] = [b.box.min[axis] - WALL_THICKNESS, b.box.max[axis]];
		if (f[axis] < -0.5)
			[r.min[axis], r.max[axis]] = [b.box.min[axis], b.box.max[axis] + WALL_THICKNESS];
	}
	return r;
}

/** A body's thinnest extent, leaving out a flat surface's none. */
function thinnest(b: Body): number {
	const size = b.box.getSize(new THREE.Vector3());
	const sides = [size.x, size.y, size.z].filter((v) => v > 1e-4);
	return sides.length ? Math.min(...sides) : SPACING_MAX;
}
