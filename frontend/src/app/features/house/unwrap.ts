import * as THREE from 'three';

/**
 * Lays every surface of the merged room out flat in one light texture (an atlas),
 * at `texel` metres a pixel, as games lay out their lightmaps: each geometry gets
 * a second set of texture coordinates, `uv1`, saying where its light is stored.
 *
 * A chart is a patch of neighbouring triangles facing within CHART_ANGLE of its
 * first one: a flat face is one chart, a curved part a few. Each is projected onto
 * the plane square to its first triangle, kept GUTTER pixels apart from the next
 * (light baked into a chart bleeds into its gutter, so filtering never reaches a
 * neighbour's), and packed in rows. Geometries must be unindexed: a vertex on two
 * charts' border needs a place in each. Deterministic: the bake and the page
 * unwrap the same geometry alike.
 *
 * Over a `previous` layout (the last bake's), every chart it has keeps its place, as
 * an engine keeps each object's place in its lightmap, and only new ones are packed,
 * in rows below: an edit then moves no light but its own, and the bake need trace
 * only near what came and went (`added`, `removed`). A chart is known by its
 * triangles, the one its plane is taken from, and its geometry's `salts` entry (what
 * it is made of): any of them changed, it is a new chart.
 */
export interface Atlas {
	width: number;
	height: number;
	/** Pixels covered by some chart, for the bake's report. */
	charts: number;
	/** Where every chart is: for the bake to keep, and the next unwrap to keep to. */
	layout: Layout;
	/** In the room, the charts the previous layout did not have, and those it had
	 *  that are gone. */
	added: THREE.Box3[];
	removed: THREE.Box3[];
	/** The pixels of the charts it did not have, each [x, y, width, height]: no bake
	 *  has lit them yet. */
	fresh: [number, number, number, number][];
}

/** A chart's place in the atlas (its corner, pixels), and where it is in the room. */
export interface Placed {
	at: [number, number];
	box: THREE.Box3;
}
/** Every chart's place, by its key. */
export type Layout = Map<string, Placed>;

/** Charts stay together while their triangles face within this of the first. */
const CHART_ANGLE = (45 * Math.PI) / 180;
/** And while each neighbour faces within this of the triangle it joins from. */
const STEP_ANGLE = (30 * Math.PI) / 180;
/** Pixels kept free round each chart, its light spread into them. */
export const GUTTER = 2;
const WIDTH = 2048;

interface Chart {
	key: string;
	geom: number;
	tris: number[];
	u: THREE.Vector3;
	v: THREE.Vector3;
	min: [number, number];
	size: [number, number];
	at: [number, number];
}

export function unwrap(
	geoms: THREE.BufferGeometry[],
	texel: number,
	previous: Layout = new Map(),
	salts: string[] = [],
): Atlas {
	const charts: Chart[] = [];
	const seen = new Map<string, number>();
	geoms.forEach((g, gi) => {
		if (g.index) throw new Error('unwrap needs unindexed geometry');
		const p = g.getAttribute('position');
		const count = p.count / 3;
		const corner = (t: number, k: number) => new THREE.Vector3().fromBufferAttribute(p, t * 3 + k);
		const normals = Array.from({ length: count }, (_, t) =>
			new THREE.Triangle(corner(t, 0), corner(t, 1), corner(t, 2)).getNormal(new THREE.Vector3()),
		);
		// Triangles meet where they share an edge: its two ends, to a tenth of a millimetre.
		const key = (v: THREE.Vector3) =>
			`${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
		const edges = new Map<string, number[]>();
		const edgeKeys = (t: number) =>
			[0, 1, 2].map((k) => {
				const [a, b] = [key(corner(t, k)), key(corner(t, (k + 1) % 3))];
				return a < b ? `${a}|${b}` : `${b}|${a}`;
			});
		for (let t = 0; t < count; t++)
			for (const e of edgeKeys(t)) edges.set(e, [...(edges.get(e) ?? []), t]);
		// Each triangle's two hashes, of its corners in order, to a tenth of a millimetre.
		const tri = (t: number, seed: number) => {
			let h = seed;
			for (let k = 0; k < 3; k++) {
				const c = corner(t, k);
				for (const v of [c.x, c.y, c.z]) h = Math.imul(h ^ Math.round(v * 1e4), 16777619);
			}
			return h >>> 0;
		};
		const salt = hash(salts[gi] ?? '');
		const chartOf = new Int32Array(count).fill(-1);
		for (let seed = 0; seed < count; seed++) {
			if (chartOf[seed] >= 0) continue;
			const n0 = normals[seed];
			const id = charts.length;
			const tris = [seed];
			chartOf[seed] = id;
			// Grown breadth first: the loop visits the triangles it adds as it goes.
			for (const t of tris) {
				for (const e of edgeKeys(t))
					for (const o of edges.get(e) ?? []) {
						if (chartOf[o] >= 0) continue;
						if (normals[o].angleTo(n0) > CHART_ANGLE || normals[o].angleTo(normals[t]) > STEP_ANGLE)
							continue;
						chartOf[o] = id;
						tris.push(o);
					}
			}
			// Its key: what it is made of, its first triangle, and the rest in any order.
			let [k1, k2] = [salt ^ tri(seed, 0x811c9dc5), salt ^ tri(seed, 0x5bd1e995)];
			for (const t of tris) {
				k1 = (k1 + Math.imul(tri(t, 0x811c9dc5), 0x9e3779b1)) >>> 0;
				k2 = (k2 + Math.imul(tri(t, 0x5bd1e995), 0x85ebca77)) >>> 0;
			}
			const base = `${k1.toString(16)}.${k2.toString(16)}`;
			const twin = seen.get(base) ?? 0;
			seen.set(base, twin + 1);
			// The chart's plane: two directions square to its first triangle's normal.
			const u = new THREE.Vector3().subVectors(corner(seed, 1), corner(seed, 0)).normalize();
			if (u.lengthSq() < 0.5) u.set(1, 0, 0);
			const v = new THREE.Vector3().crossVectors(n0, u).normalize();
			let [minU, minV, maxU, maxV] = [Infinity, Infinity, -Infinity, -Infinity];
			for (const t of tris)
				for (let k = 0; k < 3; k++) {
					const c = corner(t, k);
					minU = Math.min(minU, c.dot(u));
					maxU = Math.max(maxU, c.dot(u));
					minV = Math.min(minV, c.dot(v));
					maxV = Math.max(maxV, c.dot(v));
				}
			charts.push({
				key: twin ? `${base}~${twin}` : base,
				geom: gi,
				tris,
				u,
				v,
				min: [minU, minV],
				size: [maxU - minU, maxV - minV],
				at: [0, 0],
			});
		}
	});

	// Pack in rows, tallest first: each chart its size in pixels, a pixel at least,
	// and its gutter all round; under every chart the previous layout keeps.
	// (Less a hair: 0.4 m at 0.01 m a pixel is 40 pixels, not the 41 its rounding error makes.)
	const px = (m: number) => Math.max(1, Math.ceil(m / texel - 1e-6));
	const boxOf = (c: Chart) => {
		const p = geoms[c.geom].getAttribute('position');
		const b = new THREE.Box3();
		for (const t of c.tris)
			for (let k = 0; k < 3; k++)
				b.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, t * 3 + k));
		return b;
	};
	let x = 0;
	let y = 0;
	let row = 0;
	let covered = 0;
	const added: THREE.Box3[] = [];
	const rects: [number, number, number, number][] = [];
	const fresh: number[] = [];
	charts.forEach((c, i) => {
		const was = previous.get(c.key);
		if (!was) return fresh.push(i);
		c.at = [was.at[0], was.at[1]];
		y = Math.max(y, c.at[1] - GUTTER + px(c.size[1]) + 2 * GUTTER);
		covered += px(c.size[0]) * px(c.size[1]);
		return undefined;
	});
	const order = fresh.sort((a, b) => px(charts[b].size[1]) - px(charts[a].size[1]) || a - b);
	for (const i of order) {
		const c = charts[i];
		const w = px(c.size[0]) + 2 * GUTTER;
		const h = px(c.size[1]) + 2 * GUTTER;
		if (w > WIDTH) throw new Error(`a chart ${c.size[0].toFixed(2)} m wide does not fit the atlas`);
		if (x + w > WIDTH) {
			x = 0;
			y += row;
			row = 0;
		}
		c.at = [x + GUTTER, y + GUTTER];
		x += w;
		row = Math.max(row, h);
		covered += px(c.size[0]) * px(c.size[1]);
		added.push(boxOf(c));
		rects.push([c.at[0], c.at[1], px(c.size[0]), px(c.size[1])]);
	}
	const height = Math.max(4, Math.ceil((y + row) / 4) * 4);
	const layout: Layout = new Map(charts.map((c) => [c.key, { at: c.at, box: boxOf(c) }]));
	const removed = [...previous].filter(([k]) => !layout.has(k)).map(([, p]) => p.box.clone());

	// Each corner's place: its chart's corner in the atlas, plus its offset in the
	// chart's plane, in pixels, as a fraction of the atlas.
	const uvs = geoms.map((g) => new Float32Array(g.getAttribute('position').count * 2));
	for (const c of charts) {
		const p = geoms[c.geom].getAttribute('position');
		const out = uvs[c.geom];
		const scaleU = px(c.size[0]) / Math.max(c.size[0], 1e-9);
		const scaleV = px(c.size[1]) / Math.max(c.size[1], 1e-9);
		for (const t of c.tris)
			for (let k = 0; k < 3; k++) {
				const i = t * 3 + k;
				const pos = new THREE.Vector3().fromBufferAttribute(p, i);
				const su = c.size[0] > 1e-9 ? (pos.dot(c.u) - c.min[0]) * scaleU : 0.5;
				const sv = c.size[1] > 1e-9 ? (pos.dot(c.v) - c.min[1]) * scaleV : 0.5;
				out[i * 2] = (c.at[0] + su) / WIDTH;
				out[i * 2 + 1] = (c.at[1] + sv) / height;
			}
	}
	geoms.forEach((g, i) => g.setAttribute('uv1', new THREE.Float32BufferAttribute(uvs[i], 2)));
	return { width: WIDTH, height, charts: covered, layout, added, removed, fresh: rects };
}

/** FNV-1a of a string's UTF-16 units. */
function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}
