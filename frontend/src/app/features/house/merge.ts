import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A mesh, by three's own flag: `instanceof Mesh` types its geometry and material as any. */
function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return 'isMesh' in o && o.isMesh === true;
}

/**
 * Meshes that never move, merged by what they look like: one mesh for every set
 * sharing a material, a shadow setting and a vertex layout, in room coordinates and
 * unindexed (as a lightmap's unwrap needs). A phone pays for each mesh it draws far
 * more than for its triangles, and the room is hundreds of parts in a few dozen
 * materials. Returns the merged meshes, in a fixed order: the order the lightmap is
 * laid out in.
 */
export function mergeStatic(
	scene: THREE.Scene,
	own: (g: THREE.BufferGeometry) => void,
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
		const merged = geoms.length > 1 ? mergeGeometries(geoms) : geoms[0];
		if (!merged) continue;
		for (const g of geoms) if (g !== merged) g.dispose();
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
