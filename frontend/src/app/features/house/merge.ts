import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A mesh, by three's own flag: `instanceof Mesh` types its geometry and material as any. */
function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return 'isMesh' in o && o.isMesh === true;
}

/**
 * Meshes that never move, merged by what they look like: one mesh for every set
 * sharing a room (`userData.room`, so each room can reflect its own surroundings),
 * a material, a shadow setting and a vertex layout, in room coordinates and
 * unindexed (as a lightmap's unwrap needs). A phone pays for each mesh it draws far
 * more than for its triangles, and the room is hundreds of parts in a few dozen
 * materials. What moves on a joint (`userData.moves`, `piece/part`) is merged only
 * with what moves on the same joint, at rest where it is drawn, so it can be moved
 * as one. Returns the merged meshes, in a fixed order: the order the lightmap is
 * laid out in.
 */
export function mergeStatic(
	scene: THREE.Scene,
	own: (g: THREE.BufferGeometry) => void,
): THREE.Mesh[] {
	scene.updateMatrixWorld(true);
	const groups = new Map<
		string,
		{ mesh: THREE.Mesh; material: THREE.Material; range?: THREE.GeometryGroup }[]
	>();
	for (const o of [...scene.children]) {
		if (!isMesh(o)) continue;
		const mesh = o;
		// A mesh of several materials (a part split by a plane) is merged group by group.
		const material = mesh.material;
		const pieces: { material: THREE.Material; range?: THREE.GeometryGroup }[] = Array.isArray(
			material,
		)
			? mesh.geometry.groups.map((range) => {
					const m = material.at(range.materialIndex ?? 0);
					if (!m) throw new Error(`a mesh's group ${range.materialIndex ?? 0} has no material`);
					return { material: m, range };
				})
			: [{ material }];
		const layout = Object.keys(mesh.geometry.attributes).sort().join(',');
		const room: unknown = mesh.userData['room'];
		const moves: unknown = mesh.userData['moves'];
		for (const { material, range } of pieces) {
			const key = `${String(room)}|${String(moves)}|${material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${layout}`;
			groups.set(key, [...(groups.get(key) ?? []), { mesh, material, range }]);
		}
	}
	const out: THREE.Mesh[] = [];
	for (const meshes of groups.values()) {
		// Each in room coordinates, unindexed so every layout merges with every other.
		const geoms = meshes.map(({ mesh, range }) => {
			const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			const flat = g.index ? g.toNonIndexed() : g;
			return range ? slice(flat, range) : flat;
		});
		const merged = geoms.length > 1 ? mergeGeometries(geoms) : geoms[0];
		if (!merged) continue;
		for (const g of geoms) if (g !== merged) g.dispose();
		own(merged);
		const first = meshes[0];
		const mesh = new THREE.Mesh(merged, first.material);
		mesh.castShadow = first.mesh.castShadow;
		mesh.receiveShadow = first.mesh.receiveShadow;
		const room: unknown = first.mesh.userData['room'];
		mesh.userData['room'] = room;
		const moves: unknown = first.mesh.userData['moves'];
		if (moves !== undefined) mesh.userData['moves'] = moves;
		for (const m of meshes) scene.remove(m.mesh);
		scene.add(mesh);
		out.push(mesh);
	}
	return out;
}

/** The vertices of an unindexed geometry in `range`, as a geometry of their own. */
function slice(g: THREE.BufferGeometry, range: THREE.GeometryGroup): THREE.BufferGeometry {
	const out = new THREE.BufferGeometry();
	for (const [name, attr] of Object.entries(g.attributes)) {
		const n = attr.itemSize;
		const data = attr.array.slice(range.start * n, (range.start + range.count) * n);
		out.setAttribute(name, new THREE.BufferAttribute(data, n));
	}
	g.dispose();
	return out;
}
