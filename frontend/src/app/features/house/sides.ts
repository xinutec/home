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
 * copy facing the other way (a curtain, a doorway's lining), SHEET_GAP behind it. The materials then
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
		const back = new THREE.Mesh(own2(behind(flipped(mesh.geometry)), own), material);
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

/** How far a sheet's back copy stands behind its front: under the 2 mm a baked ray
 *  starts off its surface, and far over float error, so a ray meets one side first. */
export const SHEET_GAP = 5e-4;

/** A flipped copy moved SHEET_GAP along its own normals, behind the front it copies. */
function behind(g: THREE.BufferGeometry): THREE.BufferGeometry {
	const p = g.getAttribute('position');
	const n = g.getAttribute('normal');
	for (let i = 0; i < p.count; i++)
		p.setXYZ(
			i,
			p.getX(i) + n.getX(i) * SHEET_GAP,
			p.getY(i) + n.getY(i) * SHEET_GAP,
			p.getZ(i) + n.getZ(i) * SHEET_GAP,
		);
	return g;
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

/** The way a mesh faces in the room, by its triangles' windings summed by area:
 *  one triangle could be degenerate (three corners in a line, as a floor's
 *  triangulation can make), and face nowhere. */
function worldNormal(mesh: THREE.Mesh): THREE.Vector3 {
	const g = mesh.geometry;
	const p = g.getAttribute('position');
	const count = g.index ? g.index.count : p.count;
	const at = (k: number) => {
		const i = g.index ? g.index.getX(k) : k;
		return new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
	};
	const sum = new THREE.Vector3();
	for (let k = 0; k + 2 < count; k += 3) {
		const [a, b, c] = [at(k), at(k + 1), at(k + 2)];
		sum.add(b.sub(a).cross(c.sub(a)));
	}
	return sum.normalize();
}
