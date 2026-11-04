import * as THREE from 'three';

/** A geometry turned to face the other way: each triangle wound back, each normal reversed. */
export function flipped(geom: THREE.BufferGeometry): THREE.BufferGeometry {
	const g = geom.index ? geom.toNonIndexed() : geom.clone();
	for (const name of Object.keys(g.attributes)) {
		const a = g.getAttribute(name);
		for (let t = 0; t < a.count; t += 3)
			for (let k = 0; k < a.itemSize; k++) {
				const one = a.getComponent(t + 1, k);
				a.setComponent(t + 1, k, a.getComponent(t + 2, k));
				a.setComponent(t + 2, k, one);
			}
	}
	const n = g.getAttribute('normal');
	if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
	return g;
}

/**
 * Every surface of the scene seen from one side only, as a lightmap needs: one
 * patch of light for each side anyone sees. A mesh that says which way it faces
 * (`userData.facing`, a direction in the room: a wall into its room, a floor up)
 * is turned that way; any other mesh drawn from both sides, glass aside, gains a
 * copy facing the other way (a curtain, a doorway's lining). The materials then
 * draw front faces only. A wall between two rooms is in each room's outline, so
 * each room's copy faces its own room and the two no longer meet in one plane.
 */
export function oneSided(scene: THREE.Scene, own: (g: THREE.BufferGeometry) => void): void {
	scene.updateMatrixWorld(true);
	const twoSided = new Set<THREE.Material>();
	for (const o of [...scene.children]) {
		if (!isMesh(o)) continue;
		const mesh = o;
		const material = mesh.material;
		if (Array.isArray(material) || material.side !== THREE.DoubleSide) continue;
		if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) continue;
		twoSided.add(material);
		const facing: unknown = mesh.userData['facing'];
		if (facing instanceof THREE.Vector3) {
			if (worldNormal(mesh).dot(facing) < 0) mesh.geometry = own2(flipped(mesh.geometry), own);
			continue;
		}
		const back = new THREE.Mesh(own2(flipped(mesh.geometry), own), material);
		back.position.copy(mesh.position);
		back.quaternion.copy(mesh.quaternion);
		back.scale.copy(mesh.scale);
		back.castShadow = mesh.castShadow;
		back.receiveShadow = mesh.receiveShadow;
		back.userData = { ...mesh.userData };
		scene.add(back);
	}
	for (const m of twoSided) {
		m.side = THREE.FrontSide;
		m.needsUpdate = true;
	}
}

/** A mesh, by three's own flag: `instanceof Mesh` types its geometry and material as any. */
function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return 'isMesh' in o && o.isMesh === true;
}

function own2(
	g: THREE.BufferGeometry,
	own: (g: THREE.BufferGeometry) => void,
): THREE.BufferGeometry {
	own(g);
	return g;
}

/** The way a mesh's first triangle faces, in the room, by its winding. */
function worldNormal(mesh: THREE.Mesh): THREE.Vector3 {
	const g = mesh.geometry;
	const p = g.getAttribute('position');
	const at = (k: number) => {
		const i = g.index ? g.index.getX(k) : k;
		return new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
	};
	return new THREE.Triangle(at(0), at(1), at(2)).getNormal(new THREE.Vector3());
}
