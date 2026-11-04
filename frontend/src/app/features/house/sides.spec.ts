import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { flipped, oneSided } from './sides';

const normalOf = (g: THREE.BufferGeometry, m = new THREE.Matrix4()) => {
	const p = g.getAttribute('position');
	const v = (i: number) => {
		const k = g.index ? g.index.getX(i) : i;
		return new THREE.Vector3().fromBufferAttribute(p, k).applyMatrix4(m);
	};
	return new THREE.Triangle(v(0), v(1), v(2)).getNormal(new THREE.Vector3());
};

describe('one-sided surfaces', () => {
	it('flips a plane to face the other way, winding and normals both', () => {
		const back = flipped(new THREE.PlaneGeometry(1, 1));
		expect(normalOf(back).z).toBeCloseTo(-1, 9);
		expect(back.getAttribute('normal').getZ(0)).toBe(-1);
	});

	it('turns a wall to face its room, and makes its material one-sided', () => {
		const scene = new THREE.Scene();
		const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
		wall.userData['facing'] = new THREE.Vector3(0, 0, -1); // its room is behind it
		scene.add(wall);
		oneSided(scene, () => undefined);
		expect(normalOf(wall.geometry).z).toBeCloseTo(-1, 9);
		expect(material.side).toBe(THREE.FrontSide);
		expect(scene.children).toHaveLength(1);
	});

	it('turns a floor whose first triangle is degenerate by the others', () => {
		const scene = new THREE.Scene();
		const geom = new THREE.BufferGeometry();
		// A zero-area triangle first, then a real one facing down.
		geom.setAttribute(
			'position',
			new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 3),
		);
		geom.computeVertexNormals();
		const floor = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
		floor.userData['facing'] = new THREE.Vector3(0, 1, 0);
		scene.add(floor);
		oneSided(scene, () => undefined);
		const p = floor.geometry.getAttribute('position');
		const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, i);
		const n = new THREE.Triangle(v(3), v(4), v(5)).getNormal(new THREE.Vector3());
		expect(n.y).toBeCloseTo(1, 9);
	});

	it('gives a two-sided sheet that says nothing a back of its own', () => {
		const scene = new THREE.Scene();
		const curtain = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 2),
			new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
		);
		scene.add(curtain);
		oneSided(scene, () => undefined);
		expect(scene.children).toHaveLength(2);
		const [a, b] = scene.children as THREE.Mesh[];
		expect(normalOf(a.geometry).dot(normalOf(b.geometry))).toBeCloseTo(-1, 9);
	});

	it('leaves glass two-sided, as light passes it either way', () => {
		const scene = new THREE.Scene();
		const glass = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, transmission: 0.9 });
		scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glass));
		oneSided(scene, () => undefined);
		expect(glass.side).toBe(THREE.DoubleSide);
		expect(scene.children).toHaveLength(1);
	});
});
