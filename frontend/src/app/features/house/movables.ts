import * as THREE from 'three';
import type { Movable as Falls } from './house.model';
import type { Dynamics } from './dynamics';
import type { Occluders } from './occluders';
import { MOVES_LAYER } from './image-stage';
import type { ProbeLight, ProbeUniforms } from './probes';
import { Squash, loads, sinks, squashMatrix } from './squash';

/** A box's half-sizes to the half-axes of the ellipsoid of its volume, (6/π)^(1/3). */
const BOX_TO_ELLIPSOID = Math.cbrt(6 / Math.PI);
/** Metres ahead of the eye, and below it, that a held thing is carried. */
const HOLD_AHEAD = 0.55;
const HOLD_BELOW = 0.35;
/** Seconds a soft thing takes to come most of the way back, unless it says. */
const RECOVER = 0.4;
/** Keeps a GPU resource for disposal with the view, and gives it back. */
type Own = <T extends { dispose(): void }>(r: T) => T;

/** One thing that can be picked up: its parts, carried together. */
interface Movable {
	/** Its parts, placed from its foot, middle of its footprint. */
	group: THREE.Group;
	/** Its height. */
	height: number;
	/** Its parts' points, in its own frame: its shape, as a body. */
	points: Float32Array;
	/** The ellipsoid it shades what is near it by: its slot, and its middle and
	 *  half-axes in its own frame (its parts' box's); where it was last placed. */
	occluder?: { slot: number; middle: THREE.Vector3; radii: THREE.Vector3; at?: THREE.Matrix4 };
	/** Which room's probes it reads, and the uniforms it reads them by. */
	room?: string;
	probes?: ProbeUniforms;
	/** What it weighs. */
	kg: number;
	/** Metres it is drawn below where the world has it: what gave under it (`sinks`). */
	sink: number;
	/** A soft thing's give (`Falls.give`): how far it is pressed in, the way it was
	 *  last pressed (in its own frame, from what it lay on into it), its parts' box
	 *  there, and the group its parts are drawn pressed in by. */
	soft?: { squash: Squash; way: THREE.Vector3; box: THREE.Box3; shape: THREE.Group };
}

/** Seconds a frame's step of the soft things covers at most: a long pause is no
 *  time for a cushion to come back in. */
const LONGEST = 0.1;

/**
 * The things in the room that can be picked up (`Furniture.movable`), as the room
 * view walks it. A tap on one picks it up: it is carried before the eye. A tap
 * again lets it go: it falls, tumbles and comes to rest among the room and the
 * others (`Dynamics`, the room view's one world). It is lit where it is from the
 * light probes (`ProbeLight`, every source), not baked; what shades it, and what it
 * shades, the image stage's occlusion draws (`imageStage`). A soft one (a cushion)
 * is drawn pressed in by what lies on it, and what lies on it as much lower: only
 * drawn, the world they move in keeps every shape (`Squash`).
 */
export class Movables {
	private readonly things = new Map<string, Movable>();
	private held?: { key: string; yaw: number };
	private last?: number;
	/** Whether a soft thing was still moving to where its load puts it, last frame. */
	private giving = true;

	constructor(
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
		/** What they shade what is near them by, by day, if anything. */
		private readonly occluders?: Occluders,
		/** Whether the soft ones give (the view's `soft` feature). */
		soft = true,
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
				m.layers.enable(MOVES_LAYER);
				m.updateMatrix();
				const pos = m.geometry.getAttribute('position');
				for (let i = 0; i < pos.count; i++) {
					p.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
					points.push(p.x, p.y, p.z);
				}
			}
			const inOwnFrame = new THREE.Box3().setFromArray(points);
			const falls = how(key);
			const thing: Movable = {
				group,
				kg: falls.kg,
				sink: 0,
				height: box.max.y - box.min.y,
				points: Float32Array.from(points),
				occluder: occluders && {
					slot: occluders.add(),
					middle: inOwnFrame.getCenter(new THREE.Vector3()),
					// The ellipsoid of its box's volume: the inscribed one leaves a box's
					// corners and the edges of its foot uncovered.
					radii: inOwnFrame.getSize(new THREE.Vector3()).multiplyScalar(0.5 * BOX_TO_ELLIPSOID),
				},
			};
			if (light) this.lightFromProbes(thing, parts, own);
			this.things.set(key, thing);
			if (soft && falls.give !== undefined) {
				// Its parts under a group of their own, which is drawn pressed in.
				const shape = new THREE.Group();
				shape.matrixAutoUpdate = false;
				for (const m of parts) shape.add(m);
				group.add(shape);
				thing.soft = {
					squash: new Squash({ give: falls.give, recover: falls.recover ?? RECOVER }),
					way: new THREE.Vector3(0, 1, 0),
					box: inOwnFrame,
					shape,
				};
			}
			dynamics.add(key, group, thing.points, falls);
			this.place(thing);
		}
	}

	/** Where each thing is now: its box in the room. */
	boxes(): THREE.Box3[] {
		return [...this.things.values()].map((t) => new THREE.Box3().setFromObject(t.group));
	}

	/** The light changed (a lamp, the evening): each thing shades by it now. */
	relight(): void {
		for (const t of this.things.values()) this.shadeBy(t);
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
		let moving = dynamics.step(dt) || this.held !== undefined;
		// With all at rest and every soft thing where its load puts it, nothing gives:
		// the walk's frames, most of them, pay nothing for it.
		if (moving || this.giving) {
			this.giving = this.give(Math.min(dt, LONGEST));
			if (this.giving) moving = true;
		}
		for (const [key, t] of this.things) {
			dynamics.pose(key, t.group);
			t.group.position.y -= t.sink;
		}
		for (const t of this.things.values()) this.place(t);
		// The clock runs on while all sleeps: the walker moving through the world is a
		// step's worth of time like any other (a long pause is cut short by `step`).
		this.last = now;
		return moving;
	}

	/** Draws the soft things pressed in by what is on them, `seconds` on, and every
	 *  thing lower by what gave under it; true while a soft thing still moves. */
	private give(seconds: number): boolean {
		if (![...this.things.values()].some((t) => t.soft)) return false;
		let moving = false;
		// Who holds whom up; what is in hand lies on nothing and nothing on it.
		const held = this.held?.key;
		const on = new Map(
			[...this.things.keys()].map((key) => [
				key,
				key === held ? [] : (this.dynamics.press(key)?.on ?? []).filter((k) => k !== held),
			]),
		);
		const load = loads(on, (key) => this.thing(key).kg);
		const blows = this.dynamics.blows();
		const drop = new Map<string, number>();
		const turn = new THREE.Quaternion();
		for (const [key, t] of this.things) {
			const s = t.soft;
			if (!s) continue;
			// In the air or in hand nothing presses on it: it comes back as it goes.
			const press = key === held ? undefined : this.dynamics.press(key);
			if (press) s.way.copy(press.from).applyQuaternion(turn.copy(t.group.quaternion).invert());
			// Its parts' box along the way it is pressed: the side it lies on, and through.
			const middle = s.box.getCenter(new THREE.Vector3()).dot(s.way);
			const half = s.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
			const reach =
				Math.abs(s.way.x) * half.x + Math.abs(s.way.y) * half.y + Math.abs(s.way.z) * half.z;
			const blow = blows.get(key);
			if (blow && press) s.squash.hit(blow, 2 * reach);
			if (s.squash.step(press ? (load.get(key) ?? 0) : 0, 2 * reach, seconds)) moving = true;
			s.shape.matrix.copy(squashMatrix(s.way, middle - reach, 2 * reach, s.squash.depth));
			// Its top comes down by as much of that as is upward in the room.
			const up = s.way.clone().applyQuaternion(t.group.quaternion).y;
			drop.set(key, s.squash.depth * Math.max(0, up));
		}
		const sink = sinks(on, (k) => drop.get(k) ?? 0);
		for (const [key, t] of this.things) t.sink = sink.get(key) ?? 0;
		return moving;
	}

	/** Its light from the room it is in, and its ellipsoid, as it moves. */
	private place(t: Movable): void {
		t.group.updateMatrixWorld(true);
		const o = t.occluder;
		if (o && !o.at?.equals(t.group.matrixWorld)) {
			this.occluders?.place(o.slot, t.group.matrixWorld, o.middle, o.radii);
			o.at = t.group.matrixWorld.clone();
			this.shadeBy(t);
		}
		if (!this.light || !t.probes) return;
		const { x, y, z } = t.group.position;
		const tag = this.light.at(new THREE.Vector3(x, y + t.height / 2, z));
		if (tag && tag !== t.room) {
			this.light.aim(t.probes, tag);
			t.room = tag;
		}
	}

	/** A thing's ellipsoid shades by the light where it is: which way it comes from,
	 *  and how much from that way (the probes', as last shown). */
	private shadeBy(t: Movable): void {
		const o = t.occluder;
		if (!o || !this.occluders) return;
		const middle = o.middle.clone().applyMatrix4(t.group.matrixWorld);
		const d = this.light?.directionAt(middle);
		if (d) this.occluders.light(o.slot, d.from, d.directionality);
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
				// Shaded by the others, not by itself.
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
