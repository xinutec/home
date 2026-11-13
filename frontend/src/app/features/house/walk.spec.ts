import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { mergeStatic } from './merge';
import { buildHouse } from './room-builder';
import { oneSided } from './sides';
import { Dynamics, loadRapier } from './dynamics';
import type { JointSpec } from './dynamics';
import { Joints } from './joints';
import { BODY, EYE, RUN_SPEED, WALK_SPEED, WalkControls, stickSpeed } from './walk';

const house = withModels(json as unknown as HouseScene);

const R = await loadRapier();

/** Walks in a straight line in 5 cm steps, a frame each, from standing on what is
 *  under `from`; where it ends. */
function walk(d: Dynamics, from: [number, number], to: [number, number]): [number, number] {
	let feet = new THREE.Vector3(from[0], d.ground(from[0], from[1], 1) ?? 0, from[1]);
	const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.05);
	for (let k = 0; k < steps; k++)
		feet = d.walk(feet, (to[0] - from[0]) / steps, (to[1] - from[1]) / steps);
	return [feet.x, feet.z];
}

/** A world of `meshes` on a floor, as the room view's physics holds it, those
 *  that move on `joints`. */
function world(meshes: THREE.Mesh[], joints: JointSpec[] = []): Dynamics {
	const floor = box(40, 0.1, 40, 0, -0.05, 0);
	for (const m of [floor, ...meshes]) m.updateMatrixWorld();
	return new Dynamics(R, [floor, ...meshes], joints);
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
function drawn(): Dynamics {
	const meshes = drawnMeshes();
	for (const m of meshes) m.updateMatrixWorld();
	return new Dynamics(R, meshes, new Joints(house, meshes).specs());
}

describe('walking', () => {
	it('stops a walker its radius short of a wall', () => {
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2.4).rotateY(Math.PI / 2));
		wall.position.set(0, 1.2, 0);
		const [x] = walk(world([wall]), [-1, 0], [1, 0]);
		// Its shoulders' radius, and the centimetre the world keeps it clear by.
		expect(x).toBeCloseTo(-BODY.radius - 0.01, 3);
	});

	it('keeps a walker out of a turned box, and slides it along a side', () => {
		// Turned a quarter, the box is 0.5 wide in x: the walker stops at its side.
		const c = world([box(1, 0.8, 0.5, 0, 0.4, 0, Math.PI / 2)]);
		const [x, z] = walk(c, [-1, 0.3], [1, 0.3]);
		// Its body there narrower than its shoulders, wider than its foot.
		expect(x).toBeLessThan(-0.25 - BODY.foot);
		expect(x).toBeGreaterThan(-0.25 - BODY.radius - 0.02);
		expect(Math.abs(z - 0.3)).toBeLessThan(0.3);
	});

	it('walks over what lies below its knees, and not into what stands higher', () => {
		const rug = box(1, 0.01, 1, 0, 0.005, 0);
		expect(walk(world([rug]), [-1, 0], [1, 0])[0]).toBeCloseTo(1, 2);
		const table = box(1, 0.75, 1, 0, 0.375, 0);
		const [tx] = walk(world([table]), [-1, 0], [1, 0]);
		expect(tx).toBeLessThan(-0.5 - BODY.foot);
		expect(tx).toBeGreaterThan(-0.5 - BODY.radius - 0.02);
	});

	it('stops a walker at a door where it stands now, not where it stood shut', () => {
		// Shut, the door stands aside at z = 5; slid open, it stands across the way,
		// clear of where the walker then stands (a door stalls on the walker).
		const door = box(0.05, 2, 1, 0, 1, 5);
		door.userData['moves'] = 'cupboard/door';
		const c = world(
			[door],
			[
				{
					key: 'cupboard/door',
					type: 'slide',
					origin: new THREE.Vector3(0, 1, 5),
					axis: new THREE.Vector3(0, 0, -1),
					limits: [0, 5],
				},
			],
		);
		expect(walk(c, [-1, 0], [1, 0])[0]).toBeCloseTo(1, 2);
		c.aim('cupboard/door', 5);
		for (let i = 0; i < 600 && c.step(1 / 60); i++);
		expect(c.at('cupboard/door')).toBeCloseTo(5, 2);
		expect(walk(c, [-1, 0], [1, 0])[0]).toBeLessThan(-0.025 - BODY.radius);
	});

	it('stops a walker at a door turned across its way, and lets it pass beside', () => {
		// Hinged at its middle, turned a quarter it lies along x.
		const door = box(0.05, 2, 1, 0, 1, 0);
		door.userData['moves'] = 'cupboard/door';
		const c = world(
			[door],
			[
				{
					key: 'cupboard/door',
					type: 'hinge',
					origin: new THREE.Vector3(0, 1, 0),
					axis: new THREE.Vector3(0, 1, 0),
					limits: [0, 90],
				},
			],
		);
		c.aim('cupboard/door', 90);
		for (let i = 0; i < 600 && c.step(1 / 60); i++);
		expect(c.at('cupboard/door')).toBeCloseTo(90, 0);
		expect(walk(c, [-1, 0.6], [1, 0.6])[0]).toBeCloseTo(1, 2);
		expect(walk(c, [0, -1], [0, 1])[1]).toBeLessThan(-0.025 - BODY.radius);
	});

	const house3d = drawn();

	it('lets a walker through the living room’s doorway to the dining room, not through its wall', () => {
		const [through] = walk(house3d, [0.4, 1.5], [-2.5, 1.5]);
		expect(through).toBeLessThan(-1.4);
		const [blocked] = walk(house3d, [0.4, 0.4], [-2.5, 0.4]);
		expect(blocked).toBeGreaterThan(-1.32);
	});

	it('drops a walker straight down onto a gentle slope under it, not along it', () => {
		// A slab tilted 20° about z, its top 10 cm under the walker's feet: clear of
		// its foot's edge, which lands first, 4 cm up the slope from its middle.
		const slope = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 2));
		slope.position.set(0, 0.5, 0);
		slope.rotation.z = Math.PI / 9;
		const c = world([slope]);
		const top = c.ground(0, 0, 2) ?? 0;
		const feet = new THREE.Vector3(0, top + 0.1, 0);
		const to = c.walk(feet, 0.01, 0);
		expect(Math.hypot(to.x - feet.x, to.z - feet.z)).toBeLessThanOrEqual(0.01 + 1e-6);
		expect(to.y).toBeLessThan(feet.y - 0.03);
	});

	it('in the real house, a wandering walk never goes further in a frame than asked', () => {
		// As the room view builds it, merged. From the living room the walk climbs onto
		// the bay sofa and off it again: off it, the walker slid along the seat's
		// rounded edge 0.9 m in one frame (step 580).
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, house, new MaterialLibrary(stage.own, false), false, false);
		oneSided(stage.scene, () => undefined);
		const fixed = mergeStatic(stage.scene, () => undefined);
		const d = new Dynamics(R, fixed, new Joints(house, fixed).specs());
		let seed = 1;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		let feet = new THREE.Vector3(0.4, d.ground(0.4, 1.5, 1.5) ?? 0, 1.5);
		let heading = random() * Math.PI * 2;
		let stuck = 0;
		let furthest = 0;
		for (let i = 0; i < 700; i++) {
			heading += (random() - 0.5) * 0.3;
			const step = (random() < 0.5 ? WALK_SPEED : RUN_SPEED) * (random() < 0.1 ? 0.05 : 1 / 60);
			const [dx, dz] = [Math.sin(heading) * step, Math.cos(heading) * step];
			const to = d.walk(feet, dx, dz);
			d.step(1 / 60);
			const went = Math.hypot(to.x - feet.x, to.z - feet.z);
			furthest = Math.max(furthest, went - step);
			stuck = went < step * 0.2 ? stuck + 1 : 0;
			if (stuck > 20) [heading, stuck] = [heading + Math.PI * (0.5 + random()), 0];
			feet = to;
		}
		expect(furthest).toBeLessThan(0.002);
	}, 120_000);

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
			// A first step of 30 cm the way it looks, taken whole: not from inside
			// something, nor into it.
			const d = Math.hypot(lx - ex, lz - ez);
			let to = new THREE.Vector3(ex, feet, ez);
			for (let k = 0; k < 15; k++)
				to = house3d.walk(to, ((lx - ex) / d) * 0.02, ((lz - ez) / d) * 0.02);
			expect(
				Math.hypot(to.x - ex, to.z - ez),
				`${room.name}: its first step is blocked`,
			).toBeCloseTo(0.3, 3);
		}
	});

	it('walks into the bean bag by the fireplace, not up its side', () => {
		const bag = house.furniture.find((f) => f.id === 'living-bean-bag');
		expect(bag).toBeDefined();
		const [cx, cz] = [bag?.cx ?? 0, bag?.cz ?? 0];
		// At it from the front, and from the hearth's side, a frame at a time.
		for (const [from, [dx, dz]] of [
			[
				[cx, cz + 1.0],
				[0, -0.02],
			],
			[
				[cx - 0.9, cz + 0.25],
				[0.02, 0],
			],
		] as const) {
			let feet = new THREE.Vector3(from[0], 0, from[1]);
			for (let k = 0; k < 60; k++) feet = house3d.walk(feet, dx, dz);
			expect(feet.y, `from ${from.join(', ')}`).toBeLessThan(0.06);
		}
	});

	it('walks over the yoga mat', () => {
		const mat = house.furniture.find((f) => f.id === 'living-yoga-mat');
		expect(mat).toBeDefined();
		// Along its middle, clear of the bean bag at its far end.
		const [cx, cz] = [mat?.cx ?? 0, (mat?.cz ?? 0) + 0.15];
		const [x] = walk(house3d, [cx - 0.6, cz], [cx - 0.1, cz]);
		expect(x).toBeCloseTo(cx - 0.1, 2);
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
				world([]),
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
	function controls(width = 400, things = [box(1, 1, 1, 100, 0.5, 100)], at?: THREE.Vector3) {
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
			world(things),
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
