import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAX_OCCLUDERS, Occluders } from './occluders';

/** As the shader reads slot `m`: a point of the room, and a facing there, carried
 *  into the space where the ellipsoid is the unit sphere. */
function carried(m: THREE.Matrix4, p: THREE.Vector3, n: THREE.Vector3) {
	const e = m.elements;
	const linear = new THREE.Matrix3().setFromMatrix4(m);
	const q = p
		.clone()
		.applyMatrix3(linear)
		.add(new THREE.Vector3(e[12], e[13], e[14]));
	const f = n
		.clone()
		.applyMatrix3(linear)
		.multiply(new THREE.Vector3(e[3], e[7], e[11]))
		.normalize();
	return { q, f };
}

describe('Occluders', () => {
	// A cushion lying turned on a shelf: its ellipsoid's half-axes 21, 7 and 21 cm,
	// round a middle 7 cm over its foot.
	const world = new THREE.Matrix4().compose(
		new THREE.Vector3(2, 0.9, -1),
		new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
		new THREE.Vector3(1, 1, 1),
	);
	const middle = new THREE.Vector3(0, 0.07, 0);
	const radii = new THREE.Vector3(0.21, 0.07, 0.21);
	const occluders = new Occluders();
	const slot = occluders.add();
	occluders.place(slot, world, middle, radii);
	const m = occluders.uniforms.occluders.value[slot];

	it('carries a point of its ellipsoid onto the unit sphere, its facing straight out from it', () => {
		for (const u of [
			new THREE.Vector3(1, 0, 0),
			new THREE.Vector3(0, 1, 0),
			new THREE.Vector3(1, 2, -3).normalize(),
		]) {
			// On the ellipsoid, in the thing's frame; its outward facing there is u over the radii.
			const local = middle.clone().add(u.clone().multiply(radii));
			const facing = u.clone().divide(radii).normalize();
			const p = local.applyMatrix4(world);
			const n = facing.transformDirection(world);
			const { q, f } = carried(m, p, n);
			expect(q.length()).toBeCloseTo(1, 5);
			expect(f.dot(q.clone().normalize())).toBeCloseTo(1, 5);
		}
	});

	it('takes no more slots than the shader has', () => {
		const full = new Occluders();
		for (let i = 0; i < MAX_OCCLUDERS; i++) full.add();
		expect(() => full.add()).toThrow(/MAX_OCCLUDERS/);
	});
});
