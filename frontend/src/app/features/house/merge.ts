import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { tessellate } from './tessellate';

/** A mesh, by three's own flag: `instanceof Mesh` types its geometry and material as any. */
function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return 'isMesh' in o && o.isMesh === true;
}

/** How finely to split for light baked onto vertices, metres: furniture parts
 *  to `part`; the room's own surfaces (`userData.shell` 'surface') to `contact`
 *  within `reach` of any part's edge, where a shadow line must be sharp (a shelf
 *  against a wall), and to `open` elsewhere, where light changes slowly, as its
 *  trim ('trim': skirting, coving) everywhere. */
export interface Split {
	part: number;
	contact: number;
	open: number;
	reach: number;
}

/**
 * Meshes that never move, merged by what they look like: one mesh for every set
 * sharing a material, a shadow setting, a vertex layout and whether it is the
 * room's shell, in room coordinates. A phone pays for each mesh it draws far more
 * than for its triangles, and the room is hundreds of parts in a few dozen
 * materials. With `split`, triangles are split for light baked onto the vertices.
 * Returns the merged meshes, in a fixed order: the order the bake is stored in.
 */
export function mergeStatic(
	scene: THREE.Scene,
	own: (g: THREE.BufferGeometry) => void,
	split?: Split,
): THREE.Mesh[] {
	scene.updateMatrixWorld(true);
	// Where the parts are, each grown and shrunk by the reach: a shadow line runs
	// along a part's edges, so a shell triangle near a contact meets the grown box
	// without lying wholly in the shrunk one (the floor hidden under a sofa).
	const near: [THREE.Box3, THREE.Box3][] = [];
	if (split)
		for (const o of scene.children)
			if (isMesh(o) && o.userData['shell'] === undefined) {
				const b = new THREE.Box3().setFromObject(o);
				near.push([b.clone().expandByScalar(split.reach), b.expandByScalar(-split.reach)]);
			}
	const shellLimit = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
		if (!split) return Infinity;
		const t = new THREE.Box3().setFromPoints([a, b, c]);
		const edge = near.some(([grown, shrunk]) => grown.intersectsBox(t) && !shrunk.containsBox(t));
		return edge ? split.contact : split.open;
	};
	const groups = new Map<string, { mesh: THREE.Mesh; material: THREE.Material }[]>();
	for (const o of [...scene.children]) {
		if (!isMesh(o)) continue;
		const mesh = o;
		const material = mesh.material;
		if (Array.isArray(material)) continue;
		const layout = Object.keys(mesh.geometry.attributes).sort().join(',');
		const shell = String(mesh.userData['shell'] ?? 'part');
		const key = `${material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${layout}|${shell}`;
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
		const shell: unknown = meshes[0].mesh.userData['shell'];
		const limit =
			shell === 'surface' ? shellLimit : shell === 'trim' ? (split?.open ?? 0) : (split?.part ?? 0);
		const cut = split ? tessellate(joined, limit) : joined;
		const merged = split ? mergeVertices(cut, 1e-5) : joined;
		for (const g of new Set([...geoms, joined, cut])) if (g !== merged) g.dispose();
		own(merged);
		const first = meshes[0];
		const mesh = new THREE.Mesh(merged, first.material);
		mesh.castShadow = first.mesh.castShadow;
		mesh.receiveShadow = first.mesh.receiveShadow;
		if (shell !== undefined) mesh.userData['shell'] = shell;
		for (const m of meshes) scene.remove(m.mesh);
		scene.add(mesh);
		out.push(mesh);
	}
	return out;
}
