import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mergeStatic } from './merge';
import { Movables } from './movables';

/** A 40 cm cushion standing on the floor at the origin, and a table 70 cm high
 *  over x > 1. */
function room(): { scene: THREE.Scene; cushion: THREE.Mesh; movables: Movables } {
	const scene = new THREE.Scene();
	const cushion = new THREE.Mesh(
		new THREE.BoxGeometry(0.4, 0.4, 0.15),
		new THREE.MeshStandardMaterial(),
	);
	cushion.position.set(0, 0.2, 0);
	cushion.userData['movable'] = 'cushion';
	scene.add(cushion);
	const ground = (x: number, _z: number, below: number) => {
		const top = x > 1 ? 0.7 : 0;
		return below >= top ? top : undefined;
	};
	const movables = new Movables(scene, [cushion], ground, [], undefined, (r) => r);
	return { scene, cushion, movables };
}

/** Frames of 16 ms until nothing moves, at most `max`. */
function settle(movables: Movables, eye: THREE.Camera, max = 200): number {
	let t = 0;
	for (let i = 0; i < max; i++) if (!movables.update((t += 16), eye)) return i;
	return max;
}

/** An eye at 1.6 m at `x`, looking along -z. */
function eye(x: number): THREE.PerspectiveCamera {
	const camera = new THREE.PerspectiveCamera();
	camera.position.set(x, 1.6, 1);
	camera.lookAt(x, 1.6, 0);
	camera.updateMatrixWorld();
	return camera;
}

describe('Movables', () => {
	it('is picked by a ray that meets it first, not through what stands before it', () => {
		const { movables } = room();
		const at = new THREE.Ray(new THREE.Vector3(0, 0.2, 2), new THREE.Vector3(0, 0, -1));
		expect(movables.pick(at, [])).toBe('cushion');
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4));
		wall.position.set(0, 0, 1);
		wall.updateMatrixWorld();
		expect(movables.pick(at, [wall])).toBeUndefined();
	});

	it('is carried before the eye, and let go falls onto what is under it, upright', () => {
		const { cushion, movables } = room();
		const camera = eye(0);
		movables.hold('cushion', camera);
		movables.update(0, camera);
		const held = cushion.getWorldPosition(new THREE.Vector3());
		expect(held.z).toBeCloseTo(1 - 0.55);
		expect(held.y).toBeGreaterThan(1);
		// Carried over the table, and let go there.
		camera.position.x = 1.5;
		camera.updateMatrixWorld();
		movables.update(16, camera);
		movables.drop();
		expect(settle(movables, camera)).toBeLessThan(200);
		const down = new THREE.Box3().setFromObject(cushion);
		expect(down.min.y).toBeCloseTo(0.7, 3);
		expect(down.max.y - down.min.y).toBeCloseTo(0.4, 3);
		expect(movables.holding).toBe(false);
	});

	it('stays out of the merged room, so it is neither baked nor merged', () => {
		// As the room view builds it: everything drawn, then merged.
		const scene = new THREE.Scene();
		const cushion = new THREE.Mesh(
			new THREE.BoxGeometry(0.4, 0.4, 0.15),
			new THREE.MeshStandardMaterial(),
		);
		cushion.userData['movable'] = 'cushion';
		scene.add(cushion);
		scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
		expect(mergeStatic(scene, () => undefined)).toHaveLength(1);
		expect(cushion.parent).toBe(scene);
	});
});
