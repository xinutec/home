import * as THREE from 'three';
import type { Movable as Falls } from './house.model';
import { ContactShadow } from './contact-shadow';
import type { Dynamics } from './dynamics';
import type { Occluders } from './occluders';
import type { ProbeLight, ProbeUniforms } from './probes';

/** Metres ahead of the eye, and below it, that a held thing is carried. */
const HOLD_AHEAD = 0.55;
const HOLD_BELOW = 0.35;
/** Keeps a GPU resource for disposal with the view, and gives it back. */
type Own = <T extends { dispose(): void }>(r: T) => T;

/** One thing that can be picked up: its parts, carried together. */
interface Movable {
	/** Its parts, placed from its foot, middle of its footprint. */
	group: THREE.Group;
	/** Its footprint's half-sizes, along its own x and z, and its height. */
	half: [number, number];
	height: number;
	shadow: ContactShadow;
	/** Where its shadow was last drawn for: its matrix then. */
	drawn?: THREE.Matrix4;
	/** Its parts' points, in its own frame: its shape, as a body. */
	points: Float32Array;
	/** The ellipsoid it shades others by: its slot, and its middle and half-axes in
	 *  its own frame (its parts' box's). */
	occluder?: { slot: number; middle: THREE.Vector3; radii: THREE.Vector3 };
	/** Which room's probes it reads, and the uniforms it reads them by. */
	room?: string;
	probes?: ProbeUniforms;
}

/**
 * The things in the room that can be picked up (`Furniture.movable`), as the room
 * view walks it. A tap on one picks it up: it is carried before the eye. A tap
 * again lets it go: it falls, tumbles and comes to rest among the room and the
 * others (`Dynamics`, the room view's one world). It is lit where it is from the
 * light probes (`ProbeLight`, every source), not baked, and has a soft shadow
 * under it.
 */
export class Movables {
	private readonly things = new Map<string, Movable>();
	private held?: { key: string; yaw: number };
	private last?: number;

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		/** Their meshes as drawn, each saying what it is part of (`userData.movable`). */
		meshes: THREE.Mesh[],
		/** The world they move in, with the room, its doors and the walker. */
		private readonly dynamics: Dynamics,
		/** Their light, if the bake has probes; else the room's approximate light. */
		private readonly light: ProbeLight | undefined,
		own: Own,
		/** How each falls, by its piece's id (`Furniture.movable`). */
		how: (key: string) => Falls,
		/** What they shade each other and the room by, if anything. */
		private readonly occluders?: Occluders,
	) {
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
			const points: number[] = [];
			const p = new THREE.Vector3();
			for (const m of parts) {
				m.position.sub(foot);
				group.add(m);
				m.updateMatrix();
				const pos = m.geometry.getAttribute('position');
				for (let i = 0; i < pos.count; i++) {
					p.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
					points.push(p.x, p.y, p.z);
				}
			}
			const size = box.getSize(new THREE.Vector3());
			// Wide enough for its shadow however it lies, with the blur round it.
			const shadow = own(new ContactShadow(renderer, group, size.length() * 1.3));
			scene.add(shadow.mesh);
			const inOwnFrame = new THREE.Box3().setFromArray(points);
			const thing: Movable = {
				group,
				half: [size.x / 2, size.z / 2],
				height: size.y,
				shadow,
				points: Float32Array.from(points),
				occluder: occluders && {
					slot: occluders.add(),
					middle: inOwnFrame.getCenter(new THREE.Vector3()),
					radii: inOwnFrame.getSize(new THREE.Vector3()).multiplyScalar(0.5),
				},
			};
			if (light) this.lightFromProbes(thing, parts, own);
			this.things.set(key, thing);
			dynamics.add(key, group, thing.points, how(key));
			this.place(key, thing);
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

	/** Picks up `key`, keeping how it is turned to the eye about the vertical; it is
	 *  carried upright. */
	hold(key: string, eye: THREE.Camera): void {
		const t = this.thing(key);
		this.dynamics.hold(key);
		const turned = new THREE.Euler().setFromQuaternion(t.group.quaternion, 'YXZ');
		this.held = { key, yaw: turned.y - yawOf(eye) };
	}

	/** Lets what is carried go, moving as the hand moved it. */
	drop(): void {
		if (!this.held) return;
		this.dynamics.release(this.held.key);
		this.held = undefined;
	}

	/** Moves what is carried and runs the physics, at `now` (ms); true while anything
	 *  still moves, so another frame should follow. */
	update(now: number, eye: THREE.Camera): boolean {
		const dynamics = this.dynamics;
		const dt = this.last === undefined ? 0 : (now - this.last) / 1000;
		if (this.held) {
			const t = this.thing(this.held.key);
			const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(eye.quaternion).setY(0).normalize();
			const at = eye.position.clone().addScaledVector(ahead, HOLD_AHEAD);
			at.y = eye.position.y - HOLD_BELOW - t.height / 2;
			const turn = new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(0, 1, 0),
				yawOf(eye) + this.held.yaw,
			);
			dynamics.follow(this.held.key, at, turn);
		}
		const moving = dynamics.step(dt) || this.held !== undefined;
		for (const [key, t] of this.things) {
			dynamics.pose(key, t.group);
			this.place(key, t);
		}
		// The clock runs on while all sleeps: the walker moving through the world is a
		// step's worth of time like any other (a long pause is cut short by `step`).
		this.last = now;
		return moving;
	}

	/** The doors and drawers pressing into a thing they cannot push away
	 *  (`Dynamics.jammed`). */
	jammed(): string[] {
		return this.dynamics.jammed();
	}

	/** The highest surface under a thing's footprint, below its foot (the room, its
	 *  doors where they stand, other things): where its shadow falls. */
	private under(key: string, t: Movable): number | undefined {
		const { x, y, z } = t.group.position;
		const yaw = new THREE.Euler().setFromQuaternion(t.group.quaternion, 'YXZ').y;
		const [c, s] = [Math.cos(yaw), Math.sin(yaw)];
		let top: number | undefined;
		for (const [u, v] of [
			[0, 0],
			[1, 1],
			[1, -1],
			[-1, 1],
			[-1, -1],
		]) {
			const [dx, dz] = [u * t.half[0] * 0.8, v * t.half[1] * 0.8];
			const g = this.dynamics.ground(x + dx * c + dz * s, z - dx * s + dz * c, y + 1e-3, key);
			if (g !== undefined) top = Math.max(top ?? g, g);
		}
		return top;
	}

	/** Its shadow on what is under it, drawn again if it has moved, and its light
	 *  from the room it is in. */
	private place(key: string, t: Movable): void {
		t.group.updateMatrixWorld(true);
		const { x, y, z } = t.group.position;
		if (!t.drawn?.equals(t.group.matrixWorld)) {
			t.shadow.update(this.under(key, t));
			t.drawn = t.group.matrixWorld.clone();
			const o = t.occluder;
			if (o) this.occluders?.place(o.slot, t.group.matrixWorld, o.middle, o.radii);
		}
		if (!this.light || !t.probes) return;
		const tag = this.light.at(new THREE.Vector3(x, y + t.height / 2, z));
		if (tag && tag !== t.room) {
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
		const tag = light.at(new THREE.Vector3(x, y + t.height / 2, z));
		if (!tag) return;
		const probes = light.uniforms(tag);
		t.room = tag;
		t.probes = probes;
		const lit = (from: THREE.Material, key: string) => {
			if (!(from instanceof THREE.MeshStandardMaterial))
				throw new Error(`${key}'s part is drawn in ${from.type}, not a standard material`);
			const material = from.clone();
			material.envMap = null;
			const slot = t.occluder?.slot;
			material.onBeforeCompile = (shader) => {
				light.patch(shader, probes, 'all');
				if (slot !== undefined) this.occluders?.patch(shader, { self: slot });
			};
			material.customProgramCacheKey = () => 'moves';
			return own(material);
		};
		for (const m of parts) {
			const key = String(m.userData['movable']);
			m.material = Array.isArray(m.material)
				? m.material.map((from) => lit(from, key))
				: lit(m.material, key);
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
