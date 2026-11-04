import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mergeStatic } from './merge';

describe('mergeStatic', () => {
	const box = (mat: THREE.Material, x: number) => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
		m.position.x = x;
		return m;
	};

	it('makes one mesh of those sharing a material, in place, and keeps the rest apart', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		const b = new THREE.MeshStandardMaterial();
		scene.add(box(a, 0), box(a, 5), box(b, 10));
		expect(mergeStatic(scene, () => undefined)).toHaveLength(2);
		const meshes = scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
		expect(meshes).toHaveLength(2);
		const merged = meshes.find((m) => m.material === a);
		const bounds = new THREE.Box3().setFromObject(merged ?? new THREE.Object3D());
		expect(bounds.min.x).toBeCloseTo(-0.5, 6);
		expect(bounds.max.x).toBeCloseTo(5.5, 6);
	});

	it('splits long edges when asked, keeping the merged mesh in place', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		scene.add(box(a, 3));
		const [mesh] = mergeStatic(scene, () => undefined, {
			part: 0.3,
			contact: 0.3,
			open: 0.3,
			reach: 0,
		});
		expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(36);
		const bounds = new THREE.Box3().setFromObject(mesh);
		expect(bounds.min.x).toBeCloseTo(2.5, 6);
	});

	it('splits the shell finely only near a part, where a shadow line falls', () => {
		const scene = new THREE.Scene();
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshStandardMaterial());
		wall.userData['shell'] = 'surface';
		const shelf = box(new THREE.MeshStandardMaterial(), 0);
		shelf.scale.set(0.5, 0.05, 0.2);
		shelf.position.set(-1.5, 0, 0.1);
		scene.add(wall, shelf);
		const split = { part: 1, contact: 0.05, open: 0.5, reach: 0.05 };
		const merged = mergeStatic(scene, () => undefined, split);
		const shell = merged.find((m) => m.userData['shell'] === 'surface');
		const p = shell?.geometry.getAttribute('position');
		// Vertices crowd round the shelf, at the wall's left end, and are sparse elsewhere.
		let left = 0;
		let right = 0;
		for (let i = 0; i < (p?.count ?? 0); i++)
			if ((p?.getX(i) ?? 0) < -1) left++;
			else if ((p?.getX(i) ?? 0) > 1) right++;
		expect(left).toBeGreaterThan(right * 4);
	});

	it('keeps a shadow caster apart from a mesh that casts none', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		const lit = box(a, 0);
		lit.castShadow = true;
		scene.add(lit, box(a, 2));
		expect(mergeStatic(scene, () => undefined)).toHaveLength(2);
	});
});
