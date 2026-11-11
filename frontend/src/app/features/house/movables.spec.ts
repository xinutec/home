import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import { Dynamics, loadRapier } from './dynamics';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { mergeStatic } from './merge';
import { Joints } from './joints';
import { Movables } from './movables';
import { buildHouse } from './room-builder';
import { oneSided } from './sides';

const R = await loadRapier();

/** A 40 cm cushion standing on a floor at the origin, and a table 70 cm high over
 *  x 1 to 2. */
function room(): { cushion: THREE.Mesh; movables: Movables; dynamics: Dynamics } {
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
	for (const m of [floor, table]) m.updateMatrixWorld();
	const dynamics = new Dynamics(R, [floor, table]);
	const movables = new Movables(
		drawsNothing(),
		scene,
		[cushion],
		dynamics,
		undefined,
		(r) => r,
		() => ({ kg: 0.3 }),
	);
	return { cushion, movables, dynamics };
}

/** A renderer that draws nothing: the physics needs none, and there is no WebGL
 *  here; the shadows' drawing is seen on the page. */
function drawsNothing(): THREE.WebGLRenderer {
	const stub = {
		autoClear: true,
		getRenderTarget: () => null,
		getClearColor: (c: THREE.Color) => c,
		getClearAlpha: () => 0,
		setClearColor: () => undefined,
		setRenderTarget: () => undefined,
		render: () => undefined,
	};
	return stub as unknown as THREE.WebGLRenderer;
}

/** Frames of 16 ms from `from` (ms) until nothing moves, at most `max`; the frames
 *  it took. */
function settle(movables: Movables, eye: THREE.Camera, max = 600, from = 0): number {
	let t = from;
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

	it('is carried before the eye, and let go falls under gravity and comes to rest on what is under it', () => {
		const { cushion, movables } = room();
		const camera = eye(0);
		movables.hold('cushion', camera);
		for (let t = 16; t < 400; t += 16) movables.update(t, camera);
		const held = cushion.getWorldPosition(new THREE.Vector3());
		expect(held.z).toBeCloseTo(1 - 0.55, 1);
		expect(held.y).toBeGreaterThan(1);
		// Carried over the table, and let go there.
		camera.position.x = 1.5;
		camera.updateMatrixWorld();
		for (let t = 400; t < 1000; t += 16) movables.update(t, camera);
		movables.drop();
		expect(settle(movables, camera, 600, 22_000)).toBeLessThan(600);
		const down = new THREE.Box3().setFromObject(cushion);
		// Resting on the table, however it landed: its lowest point on the top.
		expect(down.min.y).toBeGreaterThan(0.69);
		expect(down.min.y).toBeLessThan(0.72);
		expect(movables.holding).toBe(false);
	});

	it('is pushed aside by the walker walking into it, though all had come to rest', () => {
		const { cushion, movables, dynamics } = room();
		const camera = eye(-1);
		// Everything at rest, as the room view starts it.
		expect(settle(movables, camera)).toBeLessThan(600);
		const before = cushion.getWorldPosition(new THREE.Vector3());
		// Walked along x, through where it stands, a frame at a time.
		let t = 10_000;
		let feet = new THREE.Vector3(-1, 0, 0.05);
		for (let k = 0; k < 100; k++) {
			feet = dynamics.walk(feet, 0.02, 0);
			movables.update((t += 16), camera);
		}
		const after = cushion.getWorldPosition(new THREE.Vector3());
		expect(after.distanceTo(before)).toBeGreaterThan(0.1);
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

	it('in the real house, each thing stays where it stands, from the start and while another is carried off and dropped', () => {
		// As the room view builds it: the fixed room one-sided and merged, the things apart.
		const scene = withModels(json as unknown as HouseScene);
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
		oneSided(stage.scene, () => undefined);
		const fixed = mergeStatic(stage.scene, () => undefined);
		const meshes = stage.scene.children.filter(
			(o): o is THREE.Mesh => o instanceof THREE.Mesh && o.userData['movable'] !== undefined,
		);
		const how = (key: string) => {
			const m = scene.furniture.find((f) => f.id === key)?.movable;
			if (!m) throw new Error(`${key} is not movable`);
			return m;
		};
		const movables = new Movables(
			drawsNothing(),
			stage.scene,
			meshes,
			new Dynamics(R, fixed),
			undefined,
			(r) => r,
			how,
		);
		const where = () =>
			new Map(
				movables.keys().map((k) => {
					const box = new THREE.Box3();
					for (const m of meshes) if (m.userData['movable'] === k) box.expandByObject(m);
					return [k, box.getCenter(new THREE.Vector3())];
				}),
			);
		/** Those of `keys` more than a centimetre from where they were. */
		const shifted = (keys: string[], from: Map<string, THREE.Vector3>) => {
			const now = where();
			const at = (p?: THREE.Vector3) =>
				p
					? p
							.toArray()
							.map((v) => v.toFixed(3))
							.join(',')
					: '?';
			return keys
				.filter((k) => (now.get(k)?.distanceTo(from.get(k) ?? new THREE.Vector3()) ?? 0) > 0.01)
				.map((k) => `${k}: ${at(from.get(k))} → ${at(now.get(k))}`);
		};
		const camera = eye(2.3);
		camera.position.z = 1.2;
		camera.updateMatrixWorld();
		// The physics started, as the room view starts it once drawn: nothing jumps.
		const placed = where();
		expect(settle(movables, camera)).toBeLessThan(600);
		expect(shifted(movables.keys(), placed)).toEqual([]);
		// One carried off from among the others: they stay.
		const before = where();
		movables.hold('living-jbl-speaker', camera);
		for (let t = 20_000; t < 22_000; t += 16) movables.update(t, camera);
		const others = movables.keys().filter((k) => k !== 'living-jbl-speaker');
		expect(shifted(others, before)).toEqual([]);
		// Let go, it falls to the floor before the eye and lies there, not through it.
		movables.drop();
		expect(settle(movables, camera, 600, 22_000)).toBeLessThan(600);
		const speaker = new THREE.Box3();
		for (const m of meshes)
			if (m.userData['movable'] === 'living-jbl-speaker') speaker.expandByObject(m);
		expect(speaker.min.y).toBeGreaterThan(-0.005);
		expect(speaker.min.y).toBeLessThan(0.02);
	});

	it('in the real house, a drawer shut on a box too tall for it stops on it, and the box stays', () => {
		const scene = withModels(json as unknown as HouseScene);
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
		oneSided(stage.scene, () => undefined);
		const fixed = mergeStatic(stage.scene, () => undefined);
		const joints = new Joints(scene, fixed);
		const key = 'living-sideboard/drawer-left';
		joints.set(key, joints.openAt(key));
		// A box 20 cm tall standing in it: the drawer is 17 cm deep, so it stands out.
		const cushion = new THREE.Mesh(
			new THREE.BoxGeometry(0.2, 0.2, 0.2),
			new THREE.MeshStandardMaterial(),
		);
		cushion.position.set(-0.92, 0.61 + 0.1, 0.2);
		cushion.userData['movable'] = 'cushion';
		stage.scene.add(cushion);
		const movables = new Movables(
			drawsNothing(),
			stage.scene,
			[cushion],
			new Dynamics(R, fixed),
			undefined,
			(r) => r,
			() => ({ kg: 0.3 }),
		);
		const camera = eye(-0.9);
		expect(settle(movables, camera)).toBeLessThan(600);
		const lying = cushion.getWorldPosition(new THREE.Vector3());
		// Tapped shut, the room view's frame loop running.
		joints.toggle(key, 10_000);
		for (let t = 10_000; t < 13_000; t += 16) {
			joints.update(t);
			movables.update(t, camera);
			for (const k of movables.jammed()) joints.stop(k);
		}
		// Stopped short, the cushion still in it, not thrown out nor into the cupboard.
		expect(joints.openness(key)).toBeGreaterThan(0.1);
		const now = cushion.getWorldPosition(new THREE.Vector3());
		expect(now.distanceTo(lying)).toBeLessThan(0.2);
		expect(now.y).toBeGreaterThan(0.6);
	});
});
