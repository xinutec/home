import * as THREE from 'three';

import { solidsOf } from './assembly';
import type { HouseScene } from './house.model';
import { roomPerimeter, segments, wallPanels } from './scene-geometry';

/** The walker as a column: its radius, and the heights between which anything
 *  stops it (a rug does not; a coffee table, a curtain, a wall above a sill do). */
export const BODY = { radius: 0.2, low: 0.12, high: 1.75 };
/** Eye height standing, metres. */
export const EYE = 1.6;

/** What a walker cannot pass, on the floor plan: wall stretches as segments
 *  [ax, az, bx, bz], and every part of the furniture as a turned box. */
export interface Obstacles {
	walls: [number, number, number, number][];
	boxes: { x: number; z: number; hw: number; hd: number; yaw: number }[];
}

/** The house's obstacles: every wall where it stands between the walker's feet and
 *  head (a doorway leaves a gap, a window's sill does not), and every furniture
 *  part within that height. */
export function obstaclesOf(scene: HouseScene): Obstacles {
	const walls: Obstacles['walls'] = [];
	for (const room of scene.rooms)
		segments(roomPerimeter(room)).forEach((s, i) => {
			const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
			if (len < 1e-6) return;
			const [dx, dz] = [(s.bx - s.ax) / len, (s.bz - s.az) / len];
			const ops = (room.openings ?? []).filter((o) => o.wall === i);
			for (const p of wallPanels(len, ops, scene.height))
				if (p.yb < BODY.high && p.yt > BODY.low)
					walls.push([s.ax + dx * p.a0, s.az + dz * p.a0, s.ax + dx * p.a1, s.az + dz * p.a1]);
		});
	const boxes: Obstacles['boxes'] = [];
	for (const f of scene.furniture)
		for (const s of solidsOf(f))
			if (s.y0 < BODY.high && s.y1 > BODY.low)
				boxes.push({ x: s.x, z: s.z, hw: s.hw, hd: s.hd, yaw: s.yaw });
	return { walls, boxes };
}

/** Where a walker at [x, z] ends up, pushed clear of every obstacle it overlaps. */
export function collide(x: number, z: number, o: Obstacles, r = BODY.radius): [number, number] {
	for (let round = 0; round < 4; round++) {
		for (const [ax, az, bx, bz] of o.walls) {
			const [ex, ez] = [bx - ax, bz - az];
			const t = Math.max(
				0,
				Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)),
			);
			const [cx, cz] = [ax + ex * t, az + ez * t];
			const d = Math.hypot(x - cx, z - cz);
			if (d >= r || d < 1e-9) continue;
			x = cx + ((x - cx) / d) * r;
			z = cz + ((z - cz) / d) * r;
		}
		for (const b of o.boxes) {
			// Into the box's frame (as assembly.ts turns it), to its nearest point, and out.
			const [c, n] = [Math.cos(b.yaw), Math.sin(b.yaw)];
			const [dx, dz] = [x - b.x, z - b.z];
			const u = dx * c - dz * n;
			const v = dx * n + dz * c;
			const qu = Math.max(-b.hw, Math.min(b.hw, u));
			const qv = Math.max(-b.hd, Math.min(b.hd, v));
			let [pu, pv] = [u - qu, v - qv];
			const d = Math.hypot(pu, pv);
			if (d >= r) continue;
			if (d < 1e-9) {
				// Inside: out by the nearer side.
				const [gu, gv] = [b.hw - Math.abs(u), b.hd - Math.abs(v)];
				[pu, pv] = gu < gv ? [Math.sign(u) || 1, 0] : [0, Math.sign(v) || 1];
				const push = (gu < gv ? gu : gv) + r;
				x += pu * push * c + pv * push * n;
				z += -pu * push * n + pv * push * c;
				continue;
			}
			const k = (r - d) / d;
			x += (pu * c + pv * n) * k;
			z += (-pu * n + pv * c) * k;
		}
	}
	return [x, z];
}

/**
 * Walking the house in the first person, on a phone or with a mouse and keys:
 * drag to look; hold the left of the screen and drag to walk (a thumb stick, drawn
 * at `stick` while held), or W A S D and the arrow keys. The walker keeps its eye
 * at standing height and is kept out of walls and furniture.
 */
export class WalkControls {
	private yaw = 0;
	private pitch = 0;
	private readonly keys = new Set<string>();
	private look?: { id: number; x: number; y: number };
	private thumb?: { id: number; x: number; y: number; dx: number; dz: number };
	private last?: number;
	private readonly off: (() => void)[] = [];

	constructor(
		private readonly camera: THREE.PerspectiveCamera,
		private readonly dom: HTMLElement,
		private readonly stick: HTMLElement,
		private readonly obstacles: Obstacles,
		private readonly changed: () => void,
		standing: boolean,
	) {
		const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
		this.yaw = e.y;
		this.pitch = standing ? 0 : e.x;
		if (standing) {
			camera.position.y = EYE;
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
	}

	/** Moves the walker by what is held since the last frame; true while it moves. */
	update(): boolean {
		const now = performance.now();
		const dt = this.last === undefined ? 0 : Math.min(0.05, (now - this.last) / 1000);
		let [ix, iz] = this.thumb ? [this.thumb.dx, this.thumb.dz] : [0, 0];
		if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) iz += 1;
		if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) iz -= 1;
		if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ix += 1;
		if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ix -= 1;
		const len = Math.hypot(ix, iz);
		if (len < 1e-3) {
			this.last = undefined;
			return false;
		}
		this.last = now;
		const speed = WALK_SPEED * Math.min(1, len);
		const [ux, uz] = [ix / Math.max(1, len), iz / Math.max(1, len)];
		const [fx, fz] = [-Math.sin(this.yaw), -Math.cos(this.yaw)];
		const [rx, rz] = [Math.cos(this.yaw), -Math.sin(this.yaw)];
		const p = this.camera.position;
		const [x, z] = collide(
			p.x + (fx * uz + rx * ux) * speed * dt,
			p.z + (fz * uz + rz * ux) * speed * dt,
			this.obstacles,
		);
		p.set(x, EYE, z);
		return true;
	}

	dispose(): void {
		for (const off of this.off) off();
		this.stick.classList.remove('held');
	}

	private down(e: PointerEvent): void {
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
		if (this.look?.id === e.pointerId) {
			// The room is grabbed, as a street view is: drag left, and the view turns right.
			this.yaw += (e.clientX - this.look.x) * LOOK_RATE;
			this.pitch = Math.max(
				-1.4,
				Math.min(1.4, this.pitch + (e.clientY - this.look.y) * LOOK_RATE),
			);
			this.look.x = e.clientX;
			this.look.y = e.clientY;
			this.orient();
			this.changed();
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
		if (this.look?.id === e.pointerId) this.look = undefined;
		if (this.thumb?.id === e.pointerId) {
			this.thumb = undefined;
			this.stick.classList.remove('held');
		}
	}

	private key(e: KeyboardEvent, down: boolean): void {
		if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) return;
		if (down) this.keys.add(e.code);
		else this.keys.delete(e.code);
		this.changed();
	}

	private orient(): void {
		this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
	}
}

/** The walker's vertical field of view, degrees. */
const WALK_FOV = 75;
/** Metres a second at the stick's full reach: an unhurried indoor walk. */
const WALK_SPEED = 1.1;
/** Radians turned a pixel dragged. */
const LOOK_RATE = 0.005;
/** The share of the screen's width, from the left, a touch there starts the stick. */
const THUMB_SHARE = 0.4;
/** Pixels the stick moves from where the thumb went down, at full speed. */
const THUMB_REACH = 60;
