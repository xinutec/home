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

	it('merges a mesh of two materials group by group, each with its own', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		const b = new THREE.MeshStandardMaterial();
		// A box, its first two faces in b, the rest in a; and a box all a.
		const two = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
		two.clearGroups();
		two.addGroup(0, 12, 1);
		two.addGroup(12, 24, 0);
		scene.add(new THREE.Mesh(two, [a, b]), box(a, 5));
		const merged = mergeStatic(scene, () => undefined);
		const count = (m: THREE.Material) =>
			merged.find((x) => x.material === m)?.geometry.getAttribute('position').count;
		expect(count(a)).toBe(24 + 36);
		expect(count(b)).toBe(12);
	});

	it('keeps a shadow caster apart from a mesh that casts none', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		const lit = box(a, 0);
		lit.castShadow = true;
		scene.add(lit, box(a, 2));
		expect(mergeStatic(scene, () => undefined)).toHaveLength(2);
	});

	it('keeps what moves on each joint apart, at rest in room coordinates, and says which joint', () => {
		const scene = new THREE.Scene();
		const a = new THREE.MeshStandardMaterial();
		const door = box(a, 0);
		door.userData['moves'] = 'cupboard/door';
		const knob = box(a, 1);
		knob.userData['moves'] = 'cupboard/door';
		const drawer = box(a, 2);
		drawer.userData['moves'] = 'cupboard/drawer';
		scene.add(box(a, 3), door, knob, drawer);
		const merged = mergeStatic(scene, () => undefined);
		expect(merged.map((m): unknown => m.userData['moves']).sort()).toEqual([
			'cupboard/door',
			'cupboard/drawer',
			undefined,
		]);
		const moving = merged.find((m) => m.userData['moves'] === 'cupboard/door');
		expect(moving?.position.x).toBe(0);
		const bounds = new THREE.Box3().setFromObject(moving ?? new THREE.Object3D());
		expect(bounds.max.x).toBeCloseTo(1.5, 6);
	});
});
