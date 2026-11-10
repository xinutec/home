import * as THREE from 'three';
import type { Room } from './house.model';
import type { ProbeLight, ProbeUniforms } from './probes';
import { roomTag } from './probes';
import { roomAt } from './scene-geometry';

/** Metres ahead of the eye, and below it, that a held thing is carried. */
const HOLD_AHEAD = 0.55;
const HOLD_BELOW = 0.35;
/** m/s²: what is let go falls. */
const GRAVITY = 9.81;
/** How dark a thing's shadow is right under it, as a share of the light there, and
 *  how high above what is under it the shadow is gone. */
const SHADOW = 0.55;
const SHADOW_FADE = 0.6;
/** How far past its footprint its shadow spreads. */
const SHADOW_SPREAD = 1.5;
/** Millimetres the shadow floats above what it falls on, against z-fighting. */
const SHADOW_LIFT = 0.002;

/** What a thing stands on: the highest surface of the fixed room under [x, z]
 *  below `below` (`Collider.ground`). */
export type Ground = (x: number, z: number, below: number) => number | undefined;

/** Keeps a GPU resource for disposal with the view, and gives it back. */
type Own = <T extends { dispose(): void }>(r: T) => T;

/** One thing that can be picked up: its parts, carried together. */
interface Movable {
	/** Its parts, placed from its foot, middle of its footprint. */
	group: THREE.Group;
	/** Its footprint's half-sizes, along its own x and z, and its height. */
	half: [number, number];
	height: number;
	shadow: THREE.Mesh;
	/** Which room's probes it reads, and the uniforms it reads them by. */
	room?: string;
	probes?: ProbeUniforms;
	/** Falling: its speed down. */
	falling?: number;
}

/**
 * The things in the room that can be picked up (`Furniture.movable`), as the room
 * view walks it. A tap on one picks it up: it is carried before the eye. A tap
 * again lets it go: it falls straight down and lands upright on the highest surface
 * under its footprint. It is lit where it is from the light probes (`ProbeLight`,
 * every source), not baked, and has a soft shadow under it.
 */
export class Movables {
	private readonly things = new Map<string, Movable>();
	private held?: { key: string; yaw: number };
	private last?: number;

	constructor(
		scene: THREE.Scene,
		/** Their meshes as drawn, each saying what it is part of (`userData.movable`). */
		meshes: THREE.Mesh[],
		private readonly ground: Ground,
		private readonly rooms: Room[],
		/** Their light, if the bake has probes; else the room's approximate light. */
		private readonly light: ProbeLight | undefined,
		own: Own,
	) {
		const shadowMap = own(blobTexture());
		const byKey = new Map<string, THREE.Mesh[]>();
		for (const m of meshes) {
			const key = String(m.userData['movable']);
			byKey.set(key, [...(byKey.get(key) ?? []), m]);
		}
		for (const [key, parts] of byKey) {
			const box = new THREE.Box3();
			for (const m of parts) box.expandByObject(m);
			const foot = new THREE.Vector3(
				(box.min.x + box.max.x) / 2,
				box.min.y,
				(box.min.z + box.max.z) / 2,
			);
			const group = new THREE.Group();
			group.position.copy(foot);
			scene.add(group);
			for (const m of parts) {
				m.position.sub(foot);
				group.add(m);
			}
			const size = box.getSize(new THREE.Vector3());
			const shadowMaterial = own(
				new THREE.MeshBasicMaterial({
					color: 0x000000,
					alphaMap: shadowMap,
					transparent: true,
					depthWrite: false,
					polygonOffset: true,
					polygonOffsetFactor: -1,
				}),
			);
			const shadow = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1)), shadowMaterial);
			shadow.rotation.x = -Math.PI / 2;
			shadow.scale.set(size.x * SHADOW_SPREAD, size.z * SHADOW_SPREAD, 1);
			scene.add(shadow);
			const thing: Movable = { group, half: [size.x / 2, size.z / 2], height: size.y, shadow };
			if (light) this.lightFromProbes(thing, parts, own);
			this.things.set(key, thing);
			this.place(thing);
		}
	}

	/** Every thing that can be picked up, by its piece's id. */
	keys(): string[] {
		return [...this.things.keys()];
	}

	/** Whether one is being carried. */
	get holding(): boolean {
		return this.held !== undefined;
	}

	/** The thing a ray first meets, unless the first thing it meets is the fixed room
	 *  (`fixed`) or nothing. */
	pick(ray: THREE.Ray, fixed: THREE.Object3D[]): string | undefined {
		const caster = new THREE.Raycaster(ray.origin, ray.direction);
		const groups = [...this.things.values()].map((t) => t.group);
		const [hit] = caster.intersectObjects([...fixed, ...groups], true);
		if (!hit) return undefined;
		for (const [key, t] of this.things) if (isIn(hit.object, t.group)) return key;
		return undefined;
	}

	/** Picks up `key`, keeping how it is turned to the eye. */
	hold(key: string, eye: THREE.Camera): void {
		const t = this.thing(key);
		t.falling = undefined;
		this.held = { key, yaw: t.group.rotation.y - yawOf(eye) };
	}

	/** Lets what is carried go: it falls. */
	drop(): void {
		if (!this.held) return;
		this.thing(this.held.key).falling = 0;
		this.held = undefined;
	}

	/** Moves what is carried or falling, at `now` (ms); true while anything still
	 *  moves, so another frame should follow. */
	update(now: number, eye: THREE.Camera): boolean {
		const dt = this.last === undefined ? 0 : Math.min(0.05, (now - this.last) / 1000);
		let moving = false;
		if (this.held) {
			const t = this.thing(this.held.key);
			const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(eye.quaternion).setY(0).normalize();
			const at = eye.position.clone().addScaledVector(ahead, HOLD_AHEAD);
			t.group.position.set(at.x, eye.position.y - HOLD_BELOW - t.height / 2, at.z);
			t.group.rotation.y = yawOf(eye) + this.held.yaw;
			this.place(t);
			moving = true;
		}
		for (const t of this.things.values()) {
			if (t.falling === undefined) continue;
			const floor = this.under(t);
			t.falling += GRAVITY * dt;
			const y = t.group.position.y - t.falling * dt;
			if (floor === undefined || y > floor) {
				t.group.position.y = floor === undefined ? y : Math.max(y, floor);
				moving = true;
			} else {
				t.group.position.y = floor;
				t.falling = undefined;
			}
			this.place(t);
		}
		this.last = moving ? now : undefined;
		return moving;
	}

	/** The highest surface under a thing's footprint, below its foot. */
	private under(t: Movable): number | undefined {
		const { x, y, z } = t.group.position;
		const [c, s] = [Math.cos(t.group.rotation.y), Math.sin(t.group.rotation.y)];
		let top: number | undefined;
		for (const [u, v] of [
			[0, 0],
			[1, 1],
			[1, -1],
			[-1, 1],
			[-1, -1],
		]) {
			const [dx, dz] = [u * t.half[0] * 0.8, v * t.half[1] * 0.8];
			const g = this.ground(x + dx * c + dz * s, z - dx * s + dz * c, y + 1e-3);
			if (g !== undefined) top = Math.max(top ?? g, g);
		}
		return top;
	}

	/** Its shadow on what is under it, and its light from the room it is in. */
	private place(t: Movable): void {
		t.group.updateMatrixWorld(true);
		const { x, y, z } = t.group.position;
		const floor = this.under(t);
		t.shadow.visible = floor !== undefined;
		if (floor !== undefined) {
			t.shadow.position.set(x, floor + SHADOW_LIFT, z);
			t.shadow.rotation.z = t.group.rotation.y;
			const material = t.shadow.material;
			if (material instanceof THREE.MeshBasicMaterial)
				material.opacity = SHADOW * Math.max(0, 1 - (y - floor) / SHADOW_FADE);
		}
		if (!this.light || !t.probes) return;
		const name = roomAt(this.rooms, x, z, y + t.height / 2);
		const room = this.rooms.find((r) => r.name === name);
		const tag = room && roomTag(room);
		if (tag && tag !== t.room && this.light.has(tag)) {
			this.light.aim(t.probes, tag);
			t.room = tag;
		}
	}

	/** Lights a thing's parts from the probes: each a material of its own, which
	 *  reads them where it is. */
	private lightFromProbes(t: Movable, parts: THREE.Mesh[], own: Own): void {
		const light = this.light;
		if (!light) return;
		const { x, y, z } = t.group.position;
		const name = roomAt(this.rooms, x, z, y + t.height / 2);
		const room = this.rooms.find((r) => r.name === name);
		const tag = room && roomTag(room);
		if (!tag || !light.has(tag)) return;
		const probes = light.uniforms(tag);
		t.room = tag;
		t.probes = probes;
		for (const m of parts) {
			if (!(m.material instanceof THREE.MeshStandardMaterial))
				throw new Error('a movable part is not drawn in a standard material');
			const material = m.material.clone();
			material.envMap = null;
			material.onBeforeCompile = (shader) => light.patch(shader, probes, 'all');
			material.customProgramCacheKey = () => 'moves';
			m.material = material;
			own(material);
		}
	}

	private thing(key: string): Movable {
		const t = this.things.get(key);
		if (!t) throw new Error(`nothing movable is ${key}`);
		return t;
	}
}

/** Which way the camera looks, about the vertical. */
function yawOf(eye: THREE.Camera): number {
	const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(eye.quaternion);
	return Math.atan2(-ahead.x, -ahead.z);
}

/** Whether `o` is `group` or inside it. */
function isIn(o: THREE.Object3D, group: THREE.Group): boolean {
	for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === group) return true;
	return false;
}

/** A soft round shadow, as alpha: dark at its middle, none at its edge. */
function blobTexture(): THREE.DataTexture {
	const n = 64;
	const data = new Uint8Array(n * n * 4);
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
			const a = Math.round(255 * Math.max(0, 1 - r) ** 2);
			data.set([a, a, a, 255], (y * n + x) * 4);
		}
	const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
	t.magFilter = t.minFilter = THREE.LinearFilter;
	t.needsUpdate = true;
	return t;
}
