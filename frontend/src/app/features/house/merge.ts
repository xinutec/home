import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { tessellate } from './tessellate';

/** A mesh, by three's own flag: `instanceof Mesh` types its geometry and material as any. */
function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return 'isMesh' in o && o.isMesh === true;
}

/**
 * Meshes that never move, merged by what they look like: one mesh for every set
 * sharing a material, a shadow setting and a vertex layout, in room coordinates.
 * A phone pays for each mesh it draws far more than for its triangles, and the
 * room is hundreds of parts in a few dozen materials. With `maxEdge`, every
 * triangle is split until no edge is longer, for light baked onto the vertices.
 * Returns the merged meshes, in a fixed order: the order the bake is stored in.
 */
export function mergeStatic(
	scene: THREE.Scene,
	own: (g: THREE.BufferGeometry) => void,
	maxEdge?: number,
): THREE.Mesh[] {
	scene.updateMatrixWorld(true);
	const groups = new Map<string, { mesh: THREE.Mesh; material: THREE.Material }[]>();
	for (const o of [...scene.children]) {
		if (!isMesh(o)) continue;
		const mesh = o;
		const material = mesh.material;
		if (Array.isArray(material)) continue;
		const layout = Object.keys(mesh.geometry.attributes).sort().join(',');
		const key = `${material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${layout}`;
		groups.set(key, [...(groups.get(key) ?? []), { mesh, material }]);
	}
	const out: THREE.Mesh[] = [];
	for (const meshes of groups.values()) {
		// Each in room coordinates, unindexed so every layout merges with every other.
		const geoms = meshes.map(({ mesh }) => {
			const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			return g.index ? g.toNonIndexed() : g;
		});
		const joined = geoms.length > 1 ? mergeGeometries(geoms) : geoms[0];
		if (!joined) continue;
		// Split, then shared: a vertex of a split wall belongs to six triangles, and is
		// stored, baked and drawn once, not six times. Corners keep their separate
		// normals, so a box stays square-shaded.
		const split = maxEdge ? tessellate(joined, maxEdge) : joined;
		const merged = maxEdge ? mergeVertices(split, 1e-5) : joined;
		for (const g of new Set([...geoms, joined, split])) if (g !== merged) g.dispose();
		own(merged);
		const first = meshes[0];
		const mesh = new THREE.Mesh(merged, first.material);
		mesh.castShadow = first.mesh.castShadow;
		mesh.receiveShadow = first.mesh.receiveShadow;
		for (const m of meshes) scene.remove(m.mesh);
		scene.add(mesh);
		out.push(mesh);
	}
	return out;
}
