import * as THREE from 'three';

/** The walker as a column: its radius, and the heights above its feet between which
 *  anything stops it (a rug or a stair's riser does not, it steps up onto it; a
 *  coffee table, a curtain, a wall above a sill do). */
export const BODY = { radius: 0.2, low: 0.22, high: 1.75 };
/** Eye height standing, metres. */
export const EYE = 1.6;

/** What the walker walks in (`Dynamics`): what is under a spot, and a step taken. */
export interface Footing {
	/** The highest surface under [x, z] below `below`; none if nothing is. */
	ground(x: number, z: number, below: number): number | undefined;
	/** Walks from standing at `feet` by `dx`, `dz`; where its feet are then. */
	walk(feet: THREE.Vector3, dx: number, dz: number): THREE.Vector3;
}

/**
 * Walking the house in the first person, as a game is played: on a phone, swipe to
 * look (right looks right, up looks up) and hold the left of the screen for a thumb
 * stick (drawn at `stick` while held), pushed further to walk faster, at its edge
 * to run; tap anything to touch it (`tapped`). With a mouse, a click captures it,
 * and it looks as it moves until Esc; a click or E touches what is in the middle of
 * the view (marked by `crosshair` while captured); W A S D or the arrows walk,
 * Shift runs. The walk eases in and out; the look never does. The walker stands on
 * whatever is under it, stepping up a stair and down, its eye at standing height
 * above it, and is kept out of everything (`Footing`, the physics world).
 */
export class WalkControls {
	private yaw = 0;
	private pitch = 0;
	private readonly keys = new Set<string>();
	private look?: { id: number; x: number; y: number };
	private thumb?: { id: number; x: number; y: number; dx: number; dz: number };
	/** Its velocity on the floor, metres a second, easing toward what is held. */
	private readonly velocity = new THREE.Vector2();
	/** The height its feet stand at, and the eye's that it eases to: standing height
	 *  above them, once it walks. */
	private feet: number;
	private eye: number;
	/** Each finger down, where and when it went down, and whether it has strayed. */
	private readonly touches = new Map<number, { x: number; y: number; t: number; far: boolean }>();
	private last?: number;
	private readonly off: (() => void)[] = [];

	constructor(
		private readonly camera: THREE.PerspectiveCamera,
		private readonly dom: HTMLElement,
		private readonly stick: HTMLElement,
		private readonly footing: Footing,
		private readonly changed: () => void,
		standing: boolean,
		/** A tap, at a point on the screen (client pixels). */
		private readonly tapped: (x: number, y: number) => void = () => undefined,
		/** Shown in the middle of the view while the mouse is captured. */
		private readonly crosshair?: HTMLElement,
	) {
		const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
		this.yaw = e.y;
		this.pitch = standing ? 0 : e.x;
		const p = camera.position;
		this.feet = footing.ground(p.x, p.z, p.y) ?? 0;
		this.eye = standing ? this.feet + EYE : p.y;
		if (standing) {
			p.y = this.eye;
			// Wide enough on an upright phone to see a room, not a wall: about 45° across.
			camera.fov = WALK_FOV;
			camera.updateProjectionMatrix();
		}
		this.orient();
		const pointer = (
			type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
			f: (e: PointerEvent) => void,
		) => {
			dom.addEventListener(type, f);
			this.off.push(() => dom.removeEventListener(type, f));
		};
		pointer('pointerdown', (e) => this.down(e));
		pointer('pointermove', (e) => this.move(e));
		pointer('pointerup', (e) => this.up(e));
		pointer('pointercancel', (e) => this.up(e));
		const key = (type: 'keydown' | 'keyup', down: boolean) => {
			const f = (e: KeyboardEvent) => this.key(e, down);
			window.addEventListener(type, f);
			this.off.push(() => window.removeEventListener(type, f));
		};
		key('keydown', true);
		key('keyup', false);
		const locked = () => {
			this.crosshair?.classList.toggle('shown', this.captured());
			if (this.captured()) this.look = undefined;
		};
		document.addEventListener('pointerlockchange', locked);
		this.off.push(() => document.removeEventListener('pointerlockchange', locked));
	}

	/** Moves the walker by what is held since the last frame; true while it moves. */
	update(): boolean {
		const now = performance.now();
		const dt = this.last === undefined ? 0 : Math.min(0.05, (now - this.last) / 1000);
		// What is held: a direction, and a speed (the stick's by its reach, the keys'
		// a walk, or with Shift a run).
		let [ix, iz, speed] = [0, 0, 0];
		if (this.thumb) {
			const r = Math.hypot(this.thumb.dx, this.thumb.dz);
			[ix, iz, speed] = r > 0 ? [this.thumb.dx / r, this.thumb.dz / r, stickSpeed(r)] : [0, 0, 0];
		}
		let [kx, kz] = [0, 0];
		if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) kz += 1;
		if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) kz -= 1;
		if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
		if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
		const k = Math.hypot(kx, kz);
		if (k > 0) {
			const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
			[ix, iz, speed] = [kx / k, kz / k, run ? RUN_SPEED : WALK_SPEED];
		}
		const [fx, fz] = [-Math.sin(this.yaw), -Math.cos(this.yaw)];
		const [rx, rz] = [Math.cos(this.yaw), -Math.sin(this.yaw)];
		const target = new THREE.Vector2(fx * iz + rx * ix, fz * iz + rz * ix).multiplyScalar(speed);
		// Eased toward it, as feet are: no step starts or stops at once.
		this.velocity.lerp(target, 1 - Math.exp(-dt / EASE_S));
		const p = this.camera.position;
		const settled = Math.abs(p.y - this.eye) < STOPPED * EYE_EASE_S;
		if (speed === 0 && this.velocity.length() < STOPPED && settled) {
			this.velocity.set(0, 0);
			this.last = undefined;
			return false;
		}
		this.last = now;
		// The world slides it along what it meets, up a step or down one.
		const travel = this.velocity.length() * dt;
		const to = this.footing.walk(
			new THREE.Vector3(p.x, this.feet, p.z),
			this.velocity.x * dt,
			this.velocity.y * dt,
		);
		const [x, z] = [to.x, to.z];
		this.feet = to.y;
		// The eye follows the feet smoothly, as a head does up a flight of stairs.
		if (travel > 0) this.eye = this.feet + EYE;
		p.set(x, p.y + (this.eye - p.y) * (1 - Math.exp(-dt / EYE_EASE_S)), z);
		return true;
	}

	dispose(): void {
		for (const off of this.off) off();
		this.stick.classList.remove('held');
	}

	private down(e: PointerEvent): void {
		if (e.pointerType === 'mouse') {
			// Captured, a click touches what is in the middle (on its release). Else the
			// click captures it, and is only that; until it is captured (or if the browser
			// will not), a drag looks.
			if (this.captured()) return;
			// A browser that will not capture it says so by a rejection, or (older ones) not
			// at all.
			Promise.resolve(this.dom.requestPointerLock())
				// dev-lint: allow-ignored-error the mouse not captured, its drag goes on looking: nothing is lost
				.catch(() => undefined);
			this.look ??= { id: e.pointerId, x: e.clientX, y: e.clientY };
			this.dom.setPointerCapture(e.pointerId);
			return;
		}
		this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), far: false });
		const box = this.dom.getBoundingClientRect();
		const left = e.clientX - box.left < box.width * THUMB_SHARE;
		if (e.pointerType !== 'mouse' && left && !this.thumb) {
			this.thumb = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dz: 0 };
			this.stick.style.left = `${e.clientX - box.left}px`;
			this.stick.style.top = `${e.clientY - box.top}px`;
			this.stick.style.setProperty('--dx', '0px');
			this.stick.style.setProperty('--dy', '0px');
			this.stick.classList.add('held');
		} else this.look ??= { id: e.pointerId, x: e.clientX, y: e.clientY };
		this.dom.setPointerCapture(e.pointerId);
		this.changed();
	}

	private move(e: PointerEvent): void {
		const touch = this.touches.get(e.pointerId);
		if (touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > TAP_SLOP) touch.far = true;
		if (e.pointerType === 'mouse' && this.captured()) {
			this.turn(e.movementX * MOUSE_RATE, e.movementY * MOUSE_RATE);
		} else if (this.look?.id === e.pointerId) {
			// As a game's camera: swipe right, and it looks right. A swipe across the
			// screen turns as far on any screen.
			const rate = SWIPE_TURN / this.dom.getBoundingClientRect().width;
			this.turn((e.clientX - this.look.x) * rate, (e.clientY - this.look.y) * rate);
			this.look.x = e.clientX;
			this.look.y = e.clientY;
		} else if (this.thumb?.id === e.pointerId) {
			let [dx, dy] = [e.clientX - this.thumb.x, e.clientY - this.thumb.y];
			const d = Math.hypot(dx, dy);
			if (d > THUMB_REACH) [dx, dy] = [(dx / d) * THUMB_REACH, (dy / d) * THUMB_REACH];
			this.thumb.dx = dx / THUMB_REACH;
			this.thumb.dz = -dy / THUMB_REACH;
			this.stick.style.setProperty('--dx', `${dx}px`);
			this.stick.style.setProperty('--dy', `${dy}px`);
			this.changed();
		}
	}

	private up(e: PointerEvent): void {
		if (e.pointerType === 'mouse' && this.captured() && e.type === 'pointerup') {
			this.tapped(...this.middle());
			return;
		}
		const touch = this.touches.get(e.pointerId);
		this.touches.delete(e.pointerId);
		const near = touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) <= TAP_SLOP;
		if (
			e.type === 'pointerup' &&
			touch &&
			near &&
			!touch.far &&
			performance.now() - touch.t < TAP_MS
		)
			this.tapped(touch.x, touch.y);
		if (this.look?.id === e.pointerId) this.look = undefined;
		if (this.thumb?.id === e.pointerId) {
			this.thumb = undefined;
			this.stick.classList.remove('held');
		}
	}

	private key(e: KeyboardEvent, down: boolean): void {
		if (e.code === 'KeyE') {
			if (down) this.tapped(...this.middle());
			return;
		}
		if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right)|Shift(Left|Right))$/.test(e.code)) return;
		if (down) this.keys.add(e.code);
		else this.keys.delete(e.code);
		this.changed();
	}

	/** Turns the look right by `right` and down by `down`, radians. */
	private turn(right: number, down: number): void {
		this.yaw -= right;
		this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - down));
		this.orient();
		this.changed();
	}

	private orient(): void {
		this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
	}

	private captured(): boolean {
		return document.pointerLockElement === this.dom;
	}

	/** The middle of the view, in client pixels. */
	private middle(): [number, number] {
		const box = this.dom.getBoundingClientRect();
		return [box.left + box.width / 2, box.top + box.height / 2];
	}
}

/**
 * Metres a second for a thumb `reach` of the stick's way out (0 to 1): nothing in
 * the dead zone a resting thumb is in, a walk by three quarters, a run at its edge.
 */
export function stickSpeed(reach: number): number {
	if (reach <= DEAD_ZONE) return 0;
	if (reach <= WALK_REACH) return (WALK_SPEED * (reach - DEAD_ZONE)) / (WALK_REACH - DEAD_ZONE);
	const run = (Math.min(1, reach) - WALK_REACH) / (1 - WALK_REACH);
	return WALK_SPEED + (RUN_SPEED - WALK_SPEED) * run;
}

/** The walker's vertical field of view, degrees. */
const WALK_FOV = 75;
/** Metres a second: a walk at an everyday pace, and a run, indoors. */
export const WALK_SPEED = 1.4;
export const RUN_SPEED = 2.6;
/** Seconds the walk takes to come most of the way (63%) to a new speed. */
const EASE_S = 0.08;
/** Seconds the eye takes to come most of the way (63%) to a new height. */
const EYE_EASE_S = 0.12;
/** Metres a second under which an eased walk has stopped. */
const STOPPED = 0.01;
/** Of the stick's reach: where a resting thumb moves nothing, and where it walks. */
const DEAD_ZONE = 0.12;
const WALK_REACH = 0.75;
/** Radians a swipe across the whole screen's width turns: 115°, a third of the way
 *  round, as 0.005 a pixel did on a phone 400 wide. */
const SWIPE_TURN = 2;
/** Radians a captured mouse turns the look a pixel it moves. */
const MOUSE_RATE = 0.0022;
/** How far up or down the look goes, radians: short of straight up and down. */
const PITCH_LIMIT = 1.4;
/** The share of the screen's width, from the left, a touch there starts the stick. */
const THUMB_SHARE = 0.4;
/** Pixels a finger may stray, and milliseconds it may stay down, in a tap. */
const TAP_SLOP = 10;
const TAP_MS = 400;
/** Pixels the stick moves from where the thumb went down, at full speed. */
const THUMB_REACH = 60;
