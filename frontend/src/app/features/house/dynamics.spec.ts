import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import { Dynamics, collisionShape, loadRapier } from './dynamics';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';

function isMesh(o: THREE.Object3D): o is THREE.Mesh {
	return o instanceof THREE.Mesh;
}

/** Each movable's parts' points in the real house, by its piece's id. */
function movablePoints(): Map<string, Float32Array> {
	const scene = withModels(json as unknown as HouseScene);
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	const byKey = new Map<string, number[]>();
	const at = new THREE.Vector3();
	stage.scene.traverse((o) => {
		if (!isMesh(o) || o.userData['movable'] === undefined) return;
		const mesh = o;
		const key = String(mesh.userData['movable']);
		mesh.updateMatrixWorld();
		const pos = mesh.geometry.getAttribute('position');
		const points = byKey.get(key) ?? [];
		for (let i = 0; i < pos.count; i++) {
			at.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
			points.push(at.x, at.y, at.z);
		}
		byKey.set(key, points);
	});
	return new Map([...byKey].map(([k, p]) => [k, Float32Array.from(p)]));
}

/** How far `points` reach along `d`. */
function reach(points: Float32Array, d: THREE.Vector3): number {
	let most = -Infinity;
	for (let i = 0; i < points.length; i += 3)
		most = Math.max(most, points[i] * d.x + points[i + 1] * d.y + points[i + 2] * d.z);
	return most;
}

/** Directions spread evenly over the sphere (a Fibonacci lattice). */
const EVERY_WAY = Array.from({ length: 2000 }, (_, i) => {
	const y = 1 - (2 * (i + 0.5)) / 2000;
	const r = Math.sqrt(1 - y * y);
	return new THREE.Vector3(Math.cos(i * 2.39996) * r, y, Math.sin(i * 2.39996) * r);
});

describe('collisionShape', () => {
	const things = movablePoints();

	it('cuts no more than 5 mm off any thing, any way: else it sinks into what it lies on', () => {
		const cut = [...things].flatMap(([key, points]) => {
			const shape = collisionShape(points);
			if ('ball' in shape) return [];
			const worst = Math.max(...EVERY_WAY.map((d) => reach(points, d) - reach(shape.hull, d)));
			return worst > 0.005 ? [`${key}: ${(worst * 100).toFixed(1)} cm`] : [];
		});
		expect(cut).toEqual([]);
	});

	it('makes the ball a ball, and nothing else one', () => {
		const balls = [...things].filter(([, p]) => 'ball' in collisionShape(p)).map(([k]) => k);
		expect(balls).toEqual(['living-red-ball']);
	});
});

describe('Dynamics', () => {
	it('rests the whale dropped on a cushion lying on the floor on top of it, not in it', async () => {
		const things = movablePoints();
		const R = await loadRapier();
		const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10));
		floor.position.y = -0.05;
		const dynamics = new Dynamics(R, [floor]);
		/** `key`'s points about its foot, as `Movables` gives them. */
		const local = (key: string) => {
			const p = things.get(key);
			if (!p) throw new Error(`no ${key}`);
			const box = new THREE.Box3().setFromArray(p);
			const out = Float32Array.from(p);
			for (let i = 0; i < out.length; i += 3) {
				out[i] -= (box.min.x + box.max.x) / 2;
				out[i + 1] -= box.min.y;
				out[i + 2] -= (box.min.z + box.max.z) / 2;
			}
			return out;
		};
		// The cushion on its back: its thin side (14 cm, along z standing) now up.
		const cushion = new THREE.Object3D();
		cushion.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
		cushion.position.set(0, 0.21 + 0.07, 0);
		const cushionPoints = local('living-bay-cushion-a');
		// Its foot is its standing foot; turned on its back, its middle 7 cm up.
		for (let i = 1; i < cushionPoints.length; i += 3) cushionPoints[i] -= 0.21;
		dynamics.add('cushion', cushion, cushionPoints, { kg: 0.3 });
		const whale = new THREE.Object3D();
		whale.position.set(0, 0.4, 0);
		const whalePoints = local('living-whale');
		dynamics.add('whale', whale, whalePoints, { kg: 0.15 });
		for (let i = 0; i < 600 && dynamics.step(1 / 60); i++);
		dynamics.pose('cushion', cushion);
		dynamics.pose('whale', whale);
		const top = (o: THREE.Object3D, p: Float32Array, lowest: boolean) => {
			o.updateMatrixWorld();
			const v = new THREE.Vector3();
			let y = lowest ? Infinity : -Infinity;
			for (let i = 0; i < p.length; i += 3) {
				const h = v.fromArray(p, i).applyMatrix4(o.matrixWorld).y;
				y = lowest ? Math.min(y, h) : Math.max(y, h);
			}
			return y;
		};
		const cushionTop = top(cushion, cushionPoints, false);
		const whaleLow = top(whale, whalePoints, true);
		expect(whaleLow).toBeGreaterThan(cushionTop - 0.005);
	});
});

describe('Dynamics, with a drawer', () => {
	/** A floor, and a drawer 30 cm up: a 40 cm square bottom with a front at +x, on
	 *  its joint (`userData.moves`), sliding 30 cm along +x, shut where it is drawn.
	 *  A box 10 cm square sits in it. */
	async function drawer() {
		const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10));
		floor.position.y = -0.05;
		floor.updateMatrixWorld();
		const bottom = new THREE.BoxGeometry(0.4, 0.02, 0.4).translate(0, 0.29, 0);
		const front = new THREE.BoxGeometry(0.02, 0.2, 0.4).translate(0.21, 0.38, 0);
		const parts = [bottom, front].map((g) => {
			const m = new THREE.Mesh(g);
			m.userData['moves'] = 'chest/drawer';
			m.updateMatrixWorld();
			return m;
		});
		const dynamics = new Dynamics(
			await loadRapier(),
			[floor, ...parts],
			[
				{
					key: 'chest/drawer',
					type: 'slide',
					origin: new THREE.Vector3(0, 0.3, 0),
					axis: new THREE.Vector3(1, 0, 0),
					limits: [0, 0.3],
				},
			],
		);
		const box = new THREE.Object3D();
		box.position.set(0, 0.3, 0);
		const half = 0.05;
		const corners: number[] = [];
		for (const x of [-half, half])
			for (const y of [0, 2 * half]) for (const z of [-half, half]) corners.push(x, y, z);
		dynamics.add('box', box, Float32Array.from(corners), { kg: 0.3 });
		return { dynamics, box };
	}

	it('is pulled out by its motor, carrying what is in it, and holds it up', async () => {
		const { dynamics, box } = await drawer();
		dynamics.aim('chest/drawer', 0.3);
		for (let i = 0; i < 180; i++) dynamics.step(1 / 60);
		expect(dynamics.at('chest/drawer')).toBeCloseTo(0.3, 2);
		dynamics.pose('box', box);
		expect(box.position.x).toBeGreaterThan(0.2);
		expect(box.position.y).toBeGreaterThan(0.29);
	});

	it('goes most of its way in half a second, and comes to rest', async () => {
		const { dynamics } = await drawer();
		dynamics.aim('chest/drawer', 0.3);
		for (let i = 0; i < 30; i++) dynamics.step(1 / 60);
		expect(dynamics.at('chest/drawer')).toBeGreaterThan(0.2);
		let steps = 0;
		while (dynamics.moving('chest/drawer') && steps < 600) {
			dynamics.step(1 / 60);
			steps++;
		}
		expect(steps).toBeLessThan(600);
	});
});

describe('Dynamics, a door on its hinge', () => {
	/** A door 40 cm wide and tall at x 0.1..0.5, hinged at its +x edge, a 10 cm box
	 *  on the floor beside it at `boxAt` (x, z), and, if `wall`, a wall behind the
	 *  box, its face at z 0.25. Swung 90° toward +z. Where the door ends (degrees) and the box. */
	async function swing(wall: boolean, boxAt: [number, number]) {
		const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10));
		floor.position.y = -0.05;
		const fixed = [floor];
		if (wall) {
			const w = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.02));
			w.position.set(0.3, 0.5, 0.26);
			fixed.push(w);
		}
		for (const m of fixed) m.updateMatrixWorld();
		const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.02).translate(0.3, 0.21, 0));
		door.userData['moves'] = 'cupboard/door';
		door.updateMatrixWorld();
		const dynamics = new Dynamics(
			await loadRapier(),
			[...fixed, door],
			[
				{
					key: 'cupboard/door',
					type: 'hinge',
					origin: new THREE.Vector3(0.5, 0.21, 0),
					axis: new THREE.Vector3(0, 1, 0),
					limits: [0, 90],
				},
			],
		);
		const corners: number[] = [];
		for (const x of [-0.05, 0.05])
			for (const y of [0, 0.1]) for (const z of [-0.05, 0.05]) corners.push(x, y, z);
		const box = new THREE.Object3D();
		box.position.set(boxAt[0], 0, boxAt[1]);
		dynamics.add('box', box, Float32Array.from(corners), { kg: 0.3 });
		// Turned +90° about +y, the door's free edge (x 0.1) swings round to +z.
		dynamics.aim('cupboard/door', 90);
		for (let i = 0; i < 240; i++) dynamics.step(1 / 60);
		dynamics.pose('box', box);
		return { angle: dynamics.at('cupboard/door'), box: box.position.clone() };
	}

	it('swings open to where it is sent', async () => {
		expect((await swing(false, [2, 2])).angle).toBeCloseTo(90, 0);
	});

	it('pushes a thing in its way across the floor', async () => {
		const { angle, box } = await swing(false, [0.2, 0.12]);
		expect(angle).toBeGreaterThan(80);
		expect(box.distanceTo(new THREE.Vector3(0.2, 0, 0.12))).toBeGreaterThan(0.05);
	});

	it('stalls on a thing caught between it and a wall, and does not crush it', async () => {
		// Its near side 15 cm out: the door meets it at about 30° open.
		const { angle, box } = await swing(true, [0.2, 0.19]);
		expect(angle).toBeLessThan(45);
		expect(box.z).toBeLessThan(0.21);
	});
});
