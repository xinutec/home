import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Dynamics, loadRapier } from './dynamics';
import { mergeStatic } from './merge';
import { Movables } from './movables';

/** A 40 cm cushion standing on a floor at the origin, and a table 70 cm high over
 *  x 1 to 2. */
function room(): { cushion: THREE.Mesh; movables: Movables; fixed: THREE.Mesh[] } {
	const scene = new THREE.Scene();
	const cushion = new THREE.Mesh(
		new THREE.BoxGeometry(0.4, 0.4, 0.15),
		new THREE.MeshStandardMaterial(),
	);
	cushion.position.set(0, 0.2, 0);
	cushion.userData['movable'] = 'cushion';
	scene.add(cushion);
	const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10));
	floor.position.set(0, -0.05, 0);
	const table = new THREE.Mesh(new THREE.BoxGeometry(1, 0.7, 1));
	table.position.set(1.5, 0.35, 0);
	const fixed = [floor, table];
	const ground = (x: number, _z: number, below: number) => {
		const top = x > 1 && x < 2 ? 0.7 : 0;
		return below >= top ? top : undefined;
	};
	const movables = new Movables(
		scene,
		[cushion],
		ground,
		[],
		undefined,
		(r) => r,
		async () => new Dynamics(await loadRapier(), fixed),
	);
	return { cushion, movables, fixed };
}

/** Frames of 16 ms until nothing moves, at most `max`; the frames it took. */
function settle(movables: Movables, eye: THREE.Camera, max = 600): number {
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

	it('is carried before the eye, and let go falls under gravity and comes to rest on what is under it', async () => {
		const { cushion, movables } = room();
		const camera = eye(0);
		await movables.hold('cushion', camera);
		for (let t = 16; t < 400; t += 16) movables.update(t, camera);
		const held = cushion.getWorldPosition(new THREE.Vector3());
		expect(held.z).toBeCloseTo(1 - 0.55, 1);
		expect(held.y).toBeGreaterThan(1);
		// Carried over the table, and let go there.
		camera.position.x = 1.5;
		camera.updateMatrixWorld();
		for (let t = 400; t < 1000; t += 16) movables.update(t, camera);
		movables.drop();
		expect(settle(movables, camera)).toBeLessThan(600);
		const down = new THREE.Box3().setFromObject(cushion);
		// Resting on the table, however it landed: its lowest point on the top.
		expect(down.min.y).toBeGreaterThan(0.69);
		expect(down.min.y).toBeLessThan(0.72);
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
