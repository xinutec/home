import * as THREE from 'three';

/**
 * An unindexed geometry with every triangle split until no edge is longer than
 * `maxEdge` metres (or than it says for that triangle, given its corners): light baked onto vertices varies only from vertex to vertex,
 * so a wall drawn as two triangles could show none of its shading. Each triangle
 * is halved across its longest edge, the split interpolating every attribute;
 * the two triangles of a quad share that edge, so they split alike.
 */
export function tessellate(
	geom: THREE.BufferGeometry,
	maxEdge: number | ((a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => number),
): THREE.BufferGeometry {
	const src = geom.index ? geom.toNonIndexed() : geom;
	const names = Object.keys(src.attributes);
	const attrs = names.map((n) => src.getAttribute(n));
	const out: number[][] = names.map(() => []);
	const pos = src.getAttribute('position');
	type V = number[][]; // one vertex: each attribute's components
	const read = (i: number): V =>
		attrs.map((a) => Array.from({ length: a.itemSize }, (_, k) => a.getComponent(i, k)));
	const mid = (a: V, b: V): V => a.map((c, j) => c.map((v, k) => (v + b[j][k]) / 2));
	const len2 = (a: V, b: V) => {
		const p = a[names.indexOf('position')];
		const q = b[names.indexOf('position')];
		return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
	};
	const at = (v: V) => {
		const p = v[names.indexOf('position')];
		return new THREE.Vector3(p[0], p[1], p[2]);
	};
	const limitOf = (a: V, b: V, c: V) => {
		const m = typeof maxEdge === 'number' ? maxEdge : maxEdge(at(a), at(b), at(c));
		return m * m;
	};
	const emit = (v: V) => v.forEach((c, j) => out[j].push(...c));
	const split = (a: V, b: V, c: V, depth: number) => {
		const ab = len2(a, b);
		const bc = len2(b, c);
		const ca = len2(c, a);
		const longest = Math.max(ab, bc, ca);
		if (longest <= limitOf(a, b, c) || depth > 24) {
			emit(a);
			emit(b);
			emit(c);
			return;
		}
		// Keep the winding: split the longest edge, each half keeping the opposite vertex.
		if (longest === ab) {
			const m = mid(a, b);
			split(a, m, c, depth + 1);
			split(m, b, c, depth + 1);
		} else if (longest === bc) {
			const m = mid(b, c);
			split(b, m, a, depth + 1);
			split(m, c, a, depth + 1);
		} else {
			const m = mid(c, a);
			split(c, m, b, depth + 1);
			split(m, a, b, depth + 1);
		}
	};
	for (let t = 0; t < pos.count; t += 3) split(read(t), read(t + 1), read(t + 2), 0);
	const result = new THREE.BufferGeometry();
	names.forEach((n, j) =>
		result.setAttribute(n, new THREE.Float32BufferAttribute(out[j], attrs[j].itemSize)),
	);
	return result;
}
