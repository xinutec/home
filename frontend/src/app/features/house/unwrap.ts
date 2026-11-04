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
 */
export interface Atlas {
	width: number;
	height: number;
	/** Pixels covered by some chart, for the bake's report. */
	charts: number;
}

/** Charts stay together while their triangles face within this of the first. */
const CHART_ANGLE = (45 * Math.PI) / 180;
/** And while each neighbour faces within this of the triangle it joins from. */
const STEP_ANGLE = (30 * Math.PI) / 180;
const GUTTER = 2;
const WIDTH = 2048;

interface Chart {
	geom: number;
	tris: number[];
	u: THREE.Vector3;
	v: THREE.Vector3;
	min: [number, number];
	size: [number, number];
	at: [number, number];
}

export function unwrap(geoms: THREE.BufferGeometry[], texel: number): Atlas {
	const charts: Chart[] = [];
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
	// and its gutter all round.
	// (Less a hair: 0.4 m at 0.01 m a pixel is 40 pixels, not the 41 its rounding error makes.)
	const px = (m: number) => Math.max(1, Math.ceil(m / texel - 1e-6));
	const order = charts
		.map((_, i) => i)
		.sort((a, b) => px(charts[b].size[1]) - px(charts[a].size[1]) || a - b);
	let x = 0;
	let y = 0;
	let row = 0;
	let covered = 0;
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
	}
	const height = Math.max(4, Math.ceil((y + row) / 4) * 4);

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
	return { width: WIDTH, height, charts: covered };
}
