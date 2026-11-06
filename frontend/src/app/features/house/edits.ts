import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** A house's surfaces as a bake saw them: every triangle's corners (nine numbers
 *  each, in the room), and per triangle a hash of what it is made of. */
export interface Surfaces {
	tris: Float32Array;
	salts: Uint32Array;
}

/** Metres between the points an edit is looked for at, over every surface. */
const SPACING = 0.05;
/** A point this close to a surface is on it. */
const ON = 1e-3;
/** How far inside its triangle a point is taken, metres. */
const INSET = 2e-4;
/** The side of a cell of the grid an edit is marked in, metres. */
const CELL = 0.25;

/** The cells of the room an edit can have changed the light in. */
export class Cells {
	constructor(private readonly keys: Set<string>) {}

	get size(): number {
		return this.keys.size;
	}

	has(p: THREE.Vector3): boolean {
		return this.keys.has(
			cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)),
		);
	}

	/** Whether any cell is in `box`. */
	meets(box: THREE.Box3): boolean {
		const [x0, y0, z0] = box.min.toArray().map((v) => Math.floor(v / CELL));
		const [x1, y1, z1] = box.max.toArray().map((v) => Math.floor(v / CELL));
		for (let x = x0; x <= x1; x++)
			for (let y = y0; y <= y1; y++)
				for (let z = z0; z <= z1; z++) if (this.keys.has(cellKey(x, y, z))) return true;
		return false;
	}
}

/**
 * Where an edit, from the surfaces `was` to `now`, can have changed the light: every
 * point of either that the other has no surface at, of the same make (a board grown
 * 2 cm, its last 2 cm; a piece moved, where it was and where it is; a surface
 * painted anew, all of it), and within `margin` of one. Only that, not the whole of a
 * chart a point of it changed: a wall's board grown at its end is a new chart along
 * all the wall.
 */
export function editedCells(was: Surfaces, now: Surfaces, margin: number): Cells {
	const marked = new Set<string>();
	const reach = Math.ceil(margin / CELL);
	const mark = (p: THREE.Vector3) => {
		const [cx, cy, cz] = [p.x, p.y, p.z].map((v) => Math.floor(v / CELL));
		for (let x = -reach; x <= reach; x++)
			for (let y = -reach; y <= reach; y++)
				for (let z = -reach; z <= reach; z++) marked.add(cellKey(cx + x, cy + y, cz + z));
	};
	// Each point marks its cell once: what the next point would mark is marked already.
	const seen = new Set<string>();
	const off = (a: Surfaces, b: Surfaces) => {
		const under = surfaceOf(b);
		const near = new THREE.Vector3();
		forEachPoint(a.tris, (p, t) => {
			const cell = cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL));
			if (seen.has(cell)) return;
			// Any surface of its make there: two can meet in one place (a tile's back on
			// its wall), and the nearest is either.
			const on = under?.bvh.shapecast({
				intersectsBounds: (box) => box.distanceToPoint(p) <= ON,
				intersectsTriangle: (tri, face) =>
					b.salts[under.triangleOf(face)] === a.salts[t] &&
					tri.closestPointToPoint(p, near).distanceTo(p) <= ON,
			});
			if (on) return;
			seen.add(cell);
			mark(p);
		});
	};
	off(now, was);
	off(was, now);
	return new Cells(marked);
}

function cellKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

/** A BVH over `s`'s triangles, and which of them a face it reports is. */
function surfaceOf(
	s: Surfaces,
): { bvh: MeshBVH; triangleOf: (face: number) => number } | undefined {
	if (s.tris.length === 0) return undefined;
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(s.tris.slice(), 3));
	const bvh = new MeshBVH(g);
	// The tree orders the faces anew, not the corners: a face's first corner says
	// which triangle it was.
	const index = g.getIndex();
	return { bvh, triangleOf: (face) => Math.floor((index?.getX(face * 3) ?? face * 3) / 3) };
}

/** Points over every triangle, about SPACING apart: in rows along its longest edge,
 *  SPACING apart up to its far corner, each row as long as the triangle is there; as
 *  many as its area needs, however long and thin it is. */
function forEachPoint(tris: Float32Array, f: (p: THREE.Vector3, t: number) => void): void {
	const c = [0, 1, 2].map(() => new THREE.Vector3());
	const [from, to, p, mid] = [0, 0, 0, 0].map(() => new THREE.Vector3());
	for (let t = 0; t < tris.length / 9; t++) {
		for (let k = 0; k < 3; k++) c[k].fromArray(tris, t * 9 + k * 3);
		mid.copy(c[0]).add(c[1]).add(c[2]).divideScalar(3);
		// The longest edge first: a to b, with apex the corner across it.
		const lens = [0, 1, 2].map((k) => c[k].distanceTo(c[(k + 1) % 3]));
		const k = lens.indexOf(Math.max(...lens));
		const [a, b, apex] = [c[k], c[(k + 1) % 3], c[(k + 2) % 3]];
		const base = lens[k];
		const height = base > 0 ? (2 * triangleArea(a, b, apex)) / base : 0;
		const rows = Math.max(1, Math.ceil(height / SPACING));
		for (let r = 0; r <= rows; r++) {
			const s = r / rows;
			// The row s of the way to the apex: from a's side to b's.
			from.lerpVectors(a, apex, s);
			to.lerpVectors(b, apex, s);
			const n = Math.max(1, Math.ceil((base * (1 - s)) / SPACING));
			for (let i = 0; i <= n; i++) {
				// A hair inside: on an edge, the surface across it is as near as its own.
				p.lerpVectors(from, to, i / n);
				const d = p.distanceTo(mid);
				f(d > INSET ? p.lerp(mid, INSET / d) : p, t);
			}
		}
	}
}

function triangleArea(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
	return new THREE.Triangle(a, b, c).getArea();
}
