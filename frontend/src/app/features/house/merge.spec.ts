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
		const [mesh] = mergeStatic(scene, () => undefined, 0.3);
		expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(36);
		const bounds = new THREE.Box3().setFromObject(mesh);
		expect(bounds.min.x).toBeCloseTo(2.5, 6);
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
