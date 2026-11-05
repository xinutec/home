import * as THREE from 'three';

import { MeshBVH } from 'three-mesh-bvh';

/** The walker as a column: its radius, and the heights between which anything
 *  stops it (a rug does not; a coffee table, a curtain, a wall above a sill do). */
export const BODY = { radius: 0.2, low: 0.12, high: 1.75 };
/** Eye height standing, metres. */
export const EYE = 1.6;

/**
 * What a walker cannot pass: the drawn room's own triangles, every one between its
 * feet and head, in one BVH. The walker is a column (BODY): a capsule from BODY.low
 * to BODY.high, pushed out sideways from whatever it overlaps, so it slides along a
 * wall or round a table's edge, and steps over a rug or a hearth.
 */
export class Collider {
	private readonly bvh: MeshBVH;

	constructor(meshes: THREE.Mesh[]) {
		const pos: number[] = [];
		const v = new THREE.Vector3();
		for (const m of meshes) {
			m.updateMatrixWorld(true);
			const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
			const p = g.getAttribute('position');
			for (let i = 0; i < p.count; i++) {
				v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
				pos.push(v.x, v.y, v.z);
			}
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		this.bvh = new MeshBVH(geometry);
	}

	/** Where a walker at [x, z] ends up, pushed clear of everything it overlaps. */
	push(x: number, z: number, r = BODY.radius): [number, number] {
		const segment = new THREE.Line3(
			new THREE.Vector3(x, BODY.low + r, z),
			new THREE.Vector3(x, BODY.high - r, z),
		);
		const near = new THREE.Box3();
		const [onTri, onBody] = [new THREE.Vector3(), new THREE.Vector3()];
		for (let round = 0; round < 4; round++) {
			near.setFromPoints([segment.start, segment.end]).expandByScalar(r);
			let moved = false;
			this.bvh.shapecast({
				intersectsBounds: (b) => b.intersectsBox(near),
				intersectsTriangle: (tri) => {
					const d = tri.closestPointToSegment(segment, onTri, onBody);
					if (d >= r) return false;
					// Out sideways only: the walker keeps its feet on the floor.
					let [px, pz] = [onBody.x - onTri.x, onBody.z - onTri.z];
					let len = Math.hypot(px, pz);
					if (len < 1e-9) {
						const n = tri.getNormal(new THREE.Vector3());
						[px, pz] = [n.x, n.z];
						len = Math.hypot(px, pz);
						if (len < 1e-9) return false;
						// Through a face, the push is its whole radius, back the way it faces.
						if (px * (x - onTri.x) + pz * (z - onTri.z) < 0) [px, pz] = [-px, -pz];
					}
					const by = (r - d) / len;
					segment.start.x += px * by;
					segment.start.z += pz * by;
					segment.end.x = segment.start.x;
					segment.end.z = segment.start.z;
					moved = true;
					return false;
				},
			});
			if (!moved) break;
		}
		return [segment.start.x, segment.start.z];
	}
}

/**
 * Walking the house in the first person, on a phone or with a mouse and keys:
 * drag to look; hold the left of the screen and drag to walk (a thumb stick, drawn
 * at `stick` while held), or W A S D and the arrow keys. The walker keeps its eye
 * at standing height and is kept out of everything drawn (`Collider`).
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
		private readonly collider: Collider,
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
		const [x, z] = this.collider.push(
			p.x + (fx * uz + rx * ux) * speed * dt,
			p.z + (fz * uz + rz * ux) * speed * dt,
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
