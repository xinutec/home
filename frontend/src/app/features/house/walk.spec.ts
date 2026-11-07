import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { Collider, EYE, RUN_SPEED, WALK_SPEED, WalkControls, stickSpeed } from './walk';

const house = json as unknown as HouseScene;

/** Walks in a straight line in 5 cm steps, kept clear at each; where it ends. */
function walk(c: Collider, from: [number, number], to: [number, number]): [number, number] {
	let [x, z] = from;
	const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.05);
	for (let k = 0; k < steps; k++)
		[x, z] = c.push(x + (to[0] - from[0]) / steps, z + (to[1] - from[1]) / steps, 0);
	return [x, z];
}

/** A box w × h × d with its centre at (x, y, z), turned `yaw` about the vertical. */
function box(
	w: number,
	h: number,
	d: number,
	x: number,
	y: number,
	z: number,
	yaw = 0,
): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
	m.position.set(x, y, z);
	m.rotation.y = yaw;
	return m;
}

/** The real house's meshes, as drawn. */
function drawnMeshes(): THREE.Mesh[] {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, house, new MaterialLibrary(stage.own, false), false, false);
	return stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

/** The real house, as drawn. */
function drawn(): Collider {
	return new Collider(drawnMeshes());
}

describe('walking', () => {
	it('stops a walker its radius short of a wall', () => {
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2.4).rotateY(Math.PI / 2));
		wall.position.set(0, 1.2, 0);
		const [x] = walk(new Collider([wall]), [-1, 0], [1, 0]);
		expect(x).toBeCloseTo(-0.2, 3);
	});

	it('keeps a walker out of a turned box, and slides it along a side', () => {
		// Turned a quarter, the box is 0.5 wide in x: the walker stops at its side.
		const c = new Collider([box(1, 0.8, 0.5, 0, 0.4, 0, Math.PI / 2)]);
		const [x, z] = walk(c, [-1, 0.3], [1, 0.3]);
		expect(x).toBeLessThan(-0.25 - 0.2 + 1e-3);
		expect(Math.abs(z - 0.3)).toBeLessThan(0.3);
	});

	it('walks over what lies below its knees, and not into what stands higher', () => {
		const rug = box(1, 0.01, 1, 0, 0.005, 0);
		expect(walk(new Collider([rug]), [-1, 0], [1, 0])[0]).toBeCloseTo(1, 6);
		const table = box(1, 0.75, 1, 0, 0.375, 0);
		expect(walk(new Collider([table]), [-1, 0], [1, 0])[0]).toBeLessThan(-0.69);
	});

	it('stops a walker at a door where it stands now, not where it stood shut', () => {
		// Shut, the door stands aside at x = 5; opened, it swings across the way.
		const door = box(0.05, 2, 1, 5, 1, 0);
		door.userData['moves'] = 'cupboard/door';
		const c = new Collider([door]);
		expect(walk(c, [-1, 0], [1, 0])[0]).toBeCloseTo(1, 6);
		door.position.x = 0;
		door.updateMatrixWorld();
		expect(walk(c, [-1, 0], [1, 0])[0]).toBeLessThan(-0.025 - 0.2 + 1e-3);
		// Turned a quarter, it lies along the way: the walker passes beside it, and
		// one walking across is stopped.
		door.rotation.y = Math.PI / 2;
		door.updateMatrixWorld();
		expect(walk(c, [-1, 0.6], [1, 0.6])[0]).toBeCloseTo(1, 6);
		expect(walk(c, [0, -1], [0, 1])[1]).toBeLessThan(-0.025 - 0.2 + 1e-3);
	});

	const house3d = drawn();

	it('lets a walker through the living room’s doorway to the dining room, not through its wall', () => {
		const [through] = walk(house3d, [0.4, 1.5], [-2.5, 1.5]);
		expect(through).toBeLessThan(-1.4);
		const [blocked] = walk(house3d, [0.4, 0.4], [-2.5, 0.4]);
		expect(blocked).toBeGreaterThan(-1.32);
	});

	it('does not let a walker step over the sofa', () => {
		const [, z] = walk(house3d, [0.4, 2.0], [0.4, 3.6]);
		expect(z).toBeLessThan(2.85);
	});

	it('starts every room standing on clear floor, a first step ahead clear too', () => {
		for (const room of house.rooms) {
			expect(room.view, `${room.name} has no start`).toBeDefined();
			const [ex, ey, ez] = room.view?.eye ?? [0, 0, 0];
			const [lx, , lz] = room.view?.look ?? [0, 0, 0];
			const feet = house3d.ground(ex, ez, ey) ?? NaN;
			expect(feet, `${room.name}: its start stands on its floor`).toBeCloseTo(room.floor ?? 0, 3);
			const [x, z] = house3d.push(ex, ez, feet);
			expect(Math.hypot(x - ex, z - ez), `${room.name}: its start is in something`).toBeLessThan(
				1e-3,
			);
			const d = Math.hypot(lx - ex, lz - ez);
			const [sx, sz] = [ex + ((lx - ex) / d) * 0.3, ez + ((lz - ez) / d) * 0.3];
			const [ax, az] = house3d.push(sx, sz, feet);
			expect(Math.hypot(ax - sx, az - sz), `${room.name}: its first step is blocked`).toBeLessThan(
				1e-3,
			);
		}
	});

	it('walks over the yoga mat', () => {
		const mat = house.furniture.find((f) => f.id === 'living-yoga-mat');
		expect(mat).toBeDefined();
		// Along its middle, clear of the bean bag at its far end.
		const [cx, cz] = [mat?.cx ?? 0, (mat?.cz ?? 0) + 0.15];
		const [x] = walk(house3d, [cx - 0.6, cz], [cx - 0.1, cz]);
		expect(x).toBeCloseTo(cx - 0.1, 6);
	});

	describe('a tap', () => {
		/** A pointer event of `type` at (x, y), as a finger makes it. */
		const at = (type: string, x: number, y: number) =>
			Object.assign(new Event(type), {
				pointerId: 1,
				pointerType: 'touch',
				clientX: x,
				clientY: y,
			});

		/** Walk controls on a 400 × 800 screen, and the taps they report. */
		function controls(): { dom: HTMLElement; camera: THREE.PerspectiveCamera; taps: number[][] } {
			const dom = document.createElement('div');
			dom.getBoundingClientRect = () => new DOMRect(0, 0, 400, 800);
			dom.setPointerCapture = () => undefined;
			const camera = new THREE.PerspectiveCamera();
			const taps: number[][] = [];
			new WalkControls(
				camera,
				dom,
				document.createElement('div'),
				new Collider([new THREE.Mesh(new THREE.PlaneGeometry(1, 1))]),
				() => undefined,
				true,
				(x, y) => taps.push([x, y]),
			);
			return { dom, camera, taps };
		}

		it('is a finger put down and lifted where it went down, wherever on the screen', () => {
			const { dom, taps } = controls();
			for (const x of [300, 50]) {
				dom.dispatchEvent(at('pointerdown', x, 400));
				dom.dispatchEvent(at('pointerup', x + 2, 401));
			}
			expect(taps).toEqual([
				[300, 400],
				[50, 400],
			]);
		});

		it('is not a drag, which turns the view instead', () => {
			const { dom, camera, taps } = controls();
			const yaw = camera.rotation.y;
			dom.dispatchEvent(at('pointerdown', 300, 400));
			dom.dispatchEvent(at('pointermove', 340, 400));
			dom.dispatchEvent(at('pointerup', 340, 400));
			expect(taps).toEqual([]);
			expect(camera.rotation.y).not.toBe(yaw);
		});
	});
});

describe('the controls, as a first-person game’s', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		Reflect.deleteProperty(document, 'pointerLockElement');
	});

	/** A pointer event of `type` at (x, y), by a finger or the mouse. */
	const at = (type: string, x: number, y: number, more: object = {}) =>
		Object.assign(new Event(type), {
			pointerId: 1,
			pointerType: 'touch',
			clientX: x,
			clientY: y,
			movementX: 0,
			movementY: 0,
			...more,
		});
	const key = (type: 'keydown' | 'keyup', code: string) =>
		window.dispatchEvent(Object.assign(new Event(type), { code }));

	/** Controls on a `width` × 800 screen, far from anything to bump into, or in `world`. */
	function controls(width = 400, world = [box(1, 1, 1, 100, 0.5, 100)], at?: THREE.Vector3) {
		const dom = document.createElement('div');
		dom.getBoundingClientRect = () => new DOMRect(0, 0, width, 800);
		dom.setPointerCapture = () => undefined;
		dom.requestPointerLock = () => Promise.resolve();
		const camera = new THREE.PerspectiveCamera();
		if (at) camera.position.copy(at);
		const taps: number[][] = [];
		const walker = new WalkControls(
			camera,
			dom,
			document.createElement('div'),
			new Collider(world),
			() => undefined,
			!at,
			(x, y) => taps.push([x, y]),
		);
		return { dom, camera, taps, walker };
	}
	const forward = (c: THREE.Camera) => new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
	const right = (c: THREE.Camera) => new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);

	it('looks the way a finger swipes: right to the right, up upward', () => {
		const { dom, camera } = controls();
		const was = right(camera);
		dom.dispatchEvent(at('pointerdown', 300, 400));
		dom.dispatchEvent(at('pointermove', 340, 400));
		expect(forward(camera).dot(was)).toBeGreaterThan(0);
		dom.dispatchEvent(at('pointermove', 340, 360));
		expect(forward(camera).y).toBeGreaterThan(0);
	});

	it('turns by as much for a swipe across a phone as across a tablet', () => {
		const turned = (width: number) => {
			const { dom, camera } = controls(width);
			dom.dispatchEvent(at('pointerdown', width * 0.5, 400));
			dom.dispatchEvent(at('pointermove', width * 0.9, 400));
			return camera.rotation.y;
		};
		expect(turned(800)).toBeCloseTo(turned(400), 6);
	});

	it('stands still for a resting thumb, walks, then runs at the stick’s edge', () => {
		expect(stickSpeed(0.05)).toBe(0);
		expect(stickSpeed(0.75)).toBeCloseTo(WALK_SPEED, 6);
		expect(stickSpeed(1)).toBeCloseTo(RUN_SPEED, 6);
		expect(stickSpeed(0.4)).toBeGreaterThan(0);
		expect(stickSpeed(0.4)).toBeLessThan(WALK_SPEED);
	});

	it('walks up a flight of stairs and down again, its eye at standing height', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		// A floor, and six steps 20 cm up and 25 cm deep rising ahead (-z) to a landing.
		const floor = box(4, 0.01, 8, 0, -0.005, 0);
		const steps = Array.from({ length: 6 }, (_, i) =>
			box(1, 0.2 * (i + 1), 0.25, 0, 0.1 * (i + 1), -1.125 - 0.25 * i),
		);
		const landing = box(1, 1.2, 2, 0, 0.6, -3.5);
		const { camera, walker } = controls(400, [floor, ...steps, landing]);
		const go = (code: string, ms: number) => {
			key('keydown', code);
			for (let t = 0; t < ms; t += 16) {
				now += 16;
				walker.update();
			}
			key('keyup', code);
			for (let t = 0; t < 1000; t += 16) {
				now += 16;
				walker.update();
			}
		};
		expect(camera.position.y).toBeCloseTo(EYE, 3);
		go('KeyW', 2500);
		expect(camera.position.z).toBeLessThan(-3);
		expect(camera.position.y).toBeCloseTo(1.2 + EYE, 2);
		go('KeyS', 3000);
		expect(camera.position.z).toBeGreaterThan(0);
		expect(camera.position.y).toBeCloseTo(EYE, 2);
	});

	it('climbs the stairs from the front door to the landing', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		// By the front door, at the foot of the flight, facing up it (-x).
		const camera = new THREE.PerspectiveCamera();
		camera.position.set(2.3, EYE, 5.04);
		camera.rotation.set(0, Math.PI / 2, 0, 'YXZ');
		const div = () => document.createElement('div');
		const walker = new WalkControls(camera, div(), div(), drawn(), () => undefined, true);
		const go = (code: string, ms: number) => {
			key('keydown', code);
			for (let t = 0; t < ms; t += 16) {
				now += 16;
				walker.update();
			}
			key('keyup', code);
			for (let t = 0; t < 1000; t += 16) {
				now += 16;
				walker.update();
			}
		};
		// Up the flight to its top, by the wall at the hall's end, then right onto the
		// landing beside it.
		go('KeyW', 3000);
		go('KeyD', 1000);
		const landing = house.rooms.find((r) => r.name === 'landing');
		expect(camera.position.x).toBeLessThan(-0.9);
		expect(camera.position.z).toBeLessThan(4.6);
		expect(camera.position.y).toBeCloseTo((landing?.floor ?? NaN) + EYE, 2);
	});

	it('keeps a placed camera where it was put until it walks, then stands', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		// An upper floor 2.6 m up, the camera placed 1.2 m over it.
		const floor = box(4, 0.01, 8, 0, 2.595, 0);
		const { camera, walker } = controls(400, [floor], new THREE.Vector3(0, 3.8, 0));
		for (let t = 0; t < 500; t += 16) {
			now += 16;
			walker.update();
		}
		expect(camera.position.y).toBe(3.8);
		key('keydown', 'KeyW');
		for (let t = 0; t < 1000; t += 16) {
			now += 16;
			walker.update();
		}
		key('keyup', 'KeyW');
		expect(camera.position.y).toBeCloseTo(2.6 + EYE, 2);
	});

	it('eases into a walk and out of it, and runs with Shift', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const { camera, walker } = controls();
		/** The speed over the next frames, metres a second, and whether it still moves. */
		const speed = (ms: number) => {
			const from = camera.position.clone();
			let moving = false;
			for (let t = 0; t < ms; t += 16) {
				now += 16;
				moving = walker.update();
			}
			return { v: camera.position.distanceTo(from) / (ms / 1000), moving };
		};
		key('keydown', 'KeyW');
		walker.update();
		expect(speed(48).v).toBeLessThan(WALK_SPEED * 0.6);
		speed(500);
		expect(speed(160).v).toBeCloseTo(WALK_SPEED, 1);
		key('keydown', 'ShiftLeft');
		speed(500);
		expect(speed(160).v).toBeCloseTo(RUN_SPEED, 1);
		key('keyup', 'ShiftLeft');
		key('keyup', 'KeyW');
		expect(speed(32).moving).toBe(true);
		expect(speed(1000).moving).toBe(false);
	});

	it('captures the mouse on a click, then looks by its movement', () => {
		const { dom, camera, taps } = controls();
		let asked = false;
		dom.requestPointerLock = () => ((asked = true), Promise.resolve());
		dom.dispatchEvent(at('pointerdown', 100, 100, { pointerType: 'mouse' }));
		dom.dispatchEvent(at('pointerup', 100, 100, { pointerType: 'mouse' }));
		expect(asked).toBe(true);
		// The click that captures it opens nothing.
		expect(taps).toEqual([]);
		Object.defineProperty(document, 'pointerLockElement', { value: dom, configurable: true });
		const was = right(camera);
		dom.dispatchEvent(at('pointermove', 100, 100, { pointerType: 'mouse', movementX: 30 }));
		expect(forward(camera).dot(was)).toBeGreaterThan(0);
	});

	it('opens what is in the middle of the view, by a click with the mouse captured or by E', () => {
		const { dom, taps } = controls();
		Object.defineProperty(document, 'pointerLockElement', { value: dom, configurable: true });
		dom.dispatchEvent(at('pointerdown', 10, 10, { pointerType: 'mouse' }));
		dom.dispatchEvent(at('pointerup', 10, 10, { pointerType: 'mouse' }));
		key('keydown', 'KeyE');
		key('keyup', 'KeyE');
		expect(taps).toEqual([
			[200, 400],
			[200, 400],
		]);
	});
});
