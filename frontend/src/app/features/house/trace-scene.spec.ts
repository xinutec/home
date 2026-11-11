import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { isMesh } from './merge';
import { oneMaterialEach } from './trace-scene';

describe('oneMaterialEach', () => {
	// Two triangles, the first red and the second blue, as a mesh of two materials.
	function twoMaterials(): { scene: THREE.Scene; mesh: THREE.Mesh } {
		const g = new THREE.BufferGeometry();
		g.setAttribute(
			'position',
			new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], 3),
		);
		g.setIndex([0, 1, 2, 3, 4, 5]);
		g.addGroup(0, 3, 0);
		g.addGroup(3, 3, 1);
		const red = new THREE.MeshStandardMaterial({ color: 0xff0000 });
		const blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });
		const mesh = new THREE.Mesh(g, [red, blue]);
		mesh.position.set(2, 0, 0);
		const parent = new THREE.Group();
		parent.add(mesh);
		const scene = new THREE.Scene();
		scene.add(parent);
		return { scene, mesh };
	}

	it('draws a mesh of several materials as one mesh a material, each with its own triangles', () => {
		const { scene, mesh } = twoMaterials();
		const [red, blue] = mesh.material as THREE.Material[];
		oneMaterialEach(scene);
		expect(mesh.visible).toBe(false);
		const parts: THREE.Mesh[] = [];
		scene.traverseVisible((o) => {
			if (isMesh(o)) parts.push(o);
		});
		expect(parts.map((p) => p.material)).toEqual([red, blue]);
		const zs = (p: THREE.Mesh) => {
			const pos = p.geometry.getAttribute('position');
			return Array.from(p.geometry.index?.array ?? [], (i) => pos.getZ(i));
		};
		expect(zs(parts[0])).toEqual([0, 0, 0]);
		expect(zs(parts[1])).toEqual([1, 1, 1]);
		for (const p of parts) {
			expect(p.geometry.groups).toEqual([]);
			expect(p.position.x).toBe(2);
		}
	});

	it('splits an unindexed mesh too, as the whale’s belly is cut from its body', () => {
		const { scene, mesh } = twoMaterials();
		// Its groups kept, now over vertices.
		mesh.geometry = mesh.geometry.toNonIndexed();
		expect(mesh.geometry.groups).toHaveLength(2);
		oneMaterialEach(scene);
		const parts: THREE.Mesh[] = [];
		scene.traverseVisible((o) => {
			if (isMesh(o)) parts.push(o);
		});
		expect(parts.map((p) => Array.from(p.geometry.index?.array ?? []))).toEqual([
			[0, 1, 2],
			[3, 4, 5],
		]);
	});

	it('leaves a mesh of one material as it is', () => {
		const scene = new THREE.Scene();
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		scene.add(mesh);
		oneMaterialEach(scene);
		expect(mesh.visible).toBe(true);
		expect(scene.children).toEqual([mesh]);
	});
});
