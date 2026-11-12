import * as THREE from 'three';
import { jointInRoom, partsOf, pieceId, solidsOf } from './assembly';
import type { JointState, Solid } from './assembly';
import type { LightChange } from './bake-file';
import type { JointSpec } from './dynamics';
import type { Furniture, HouseScene, Joint } from './house.model';

/** Places along a joint's travel its reach is taken at: a door's arc, to within
 *  a millimetre or so of its corner's path. */
const REACH_STEPS = 24;
/** How little a joint moves (degrees, metres) for it to be left where it is drawn:
 *  a tenth of a millimetre at a door's edge. */
const STILL = 1e-4;

/** A solid's place in the room, as a matrix. */
function pose(s: Solid): THREE.Matrix4 {
	return new THREE.Matrix4().makeRotationY(s.yaw).setPosition(s.x, (s.y0 + s.y1) / 2, s.z);
}

/**
 * The doors and drawers of the drawn house, opened and shut. Each moves as the
 * meshes `mergeStatic` keeps for its joint (`userData.moves`), drawn at rest where
 * they stand shut: a joint's value places them by the move its part makes from
 * there, as the physics places the part (`solidsOf`). One opens to its stop, where
 * it meets something (as the gate found it), else its travel's end. Opened and
 * shut by the physics (`driveBy`), where a motor moves each as a hand would.
 */
export class Joints {
	private readonly state: JointState = {};
	/** What moves the joints, and where each was last sent. */
	private drive?: Drive;
	private readonly aims = new Map<string, number>();
	private readonly joints = new Map<string, { piece: Furniture; part: string; joint: Joint }>();
	private readonly moving = new Map<string, THREE.Mesh[]>();

	constructor(
		scene: HouseScene,
		private readonly meshes: THREE.Mesh[],
	) {
		for (const f of scene.furniture)
			for (const p of partsOf(f))
				if (p.joint)
					this.joints.set(`${pieceId(f)}/${p.id}`, { piece: f, part: p.id, joint: p.joint });
		for (const m of meshes) {
			const key: unknown = m.userData['moves'];
			if (typeof key !== 'string') continue;
			if (!this.joints.has(key)) throw new Error(`a mesh moves on ${key}, which is no joint`);
			this.moving.set(key, [...(this.moving.get(key) ?? []), m]);
		}
	}

	/** The door or drawer a ray first meets, unless the first thing it meets is fixed. */
	pick(ray: THREE.Ray): string | undefined {
		const caster = new THREE.Raycaster(ray.origin, ray.direction);
		const [hit] = caster.intersectObjects(this.meshes, false);
		const key: unknown = hit?.object.userData['moves'];
		return typeof key === 'string' ? key : undefined;
	}

	/** Every joint that has something drawn on it, by `piece/part`. */
	keys(): string[] {
		return [...this.moving.keys()];
	}

	/** Where a joint is shut. */
	closedAt(key: string): number {
		return this.joint(key).joint.range[0];
	}

	/** Where a joint opens to: its stop, else its travel's end. */
	openAt(key: string): number {
		const { range, stop } = this.joint(key).joint;
		return stop ?? range[1];
	}

	/** How far open a joint is, from 0 shut to 1 at `openAt`. */
	openness(key: string): number {
		const closed = this.closedAt(key);
		const open = this.openAt(key);
		return open === closed ? 0 : (this.value(key) - closed) / (open - closed);
	}

	/** Where a joint's parts pass through between shut and `openAt`: their bounds
	 *  at REACH_STEPS places along the way, so a door's arc is in it. Leaves the
	 *  joint where it was. */
	reach(key: string): THREE.Box3 {
		const was = this.value(key);
		const [closed, open] = [this.closedAt(key), this.openAt(key)];
		const out = new THREE.Box3();
		for (let k = 0; k <= REACH_STEPS; k++) {
			this.set(key, closed + ((open - closed) * k) / REACH_STEPS);
			for (const m of this.moving.get(key) ?? []) out.expandByObject(m);
		}
		this.set(key, was);
		return out;
	}

	/** Where a joint is: metres out, or degrees open. */
	value(key: string): number {
		return this.state[key] ?? this.joint(key).joint.range[0];
	}

	/** Puts a joint at `v`, and everything on its piece where that leaves it. */
	set(key: string, v: number): void {
		const { piece } = this.joint(key);
		this.state[key] = v;
		const id = pieceId(piece);
		const shut = solidsOf(piece);
		const now = solidsOf(piece, this.state);
		for (const [k, meshes] of this.moving) {
			const j = this.joints.get(k);
			if (j?.piece !== piece) continue;
			const i = shut.findIndex((s) => s.piece === id && s.part === j.part);
			const move = pose(now[i]).multiply(pose(shut[i]).invert());
			for (const m of meshes) {
				move.decompose(m.position, m.quaternion, m.scale);
				m.updateMatrixWorld();
			}
		}
	}

	/** Each joint with something drawn on it, as the physics puts it in the room. */
	specs(): JointSpec[] {
		return this.keys().map((key) => {
			const { piece, part, joint } = this.joint(key);
			const p = partsOf(piece).find((q) => q.id === part);
			if (!p) throw new Error(`no part ${key}`);
			const { origin, axis } = jointInRoom(piece, p);
			return {
				key,
				type: joint.type,
				origin: new THREE.Vector3(...origin),
				axis: new THREE.Vector3(...axis),
				limits: [this.closedAt(key), this.openAt(key)],
			};
		});
	}

	/** Opened and shut from now on by `drive` (the physics). */
	driveBy(drive: Drive): void {
		this.drive = drive;
	}

	/** Opens a joint that is shut or shutting, shuts one that is open or opening, or
	 *  stopped on its way there. */
	toggle(key: string): void {
		if (!this.drive) throw new Error('nothing drives the joints');
		const [closed, open] = [this.closedAt(key), this.openAt(key)];
		// Never sent: where it stands, nearer shut or open (at rest it settles a
		// hair off either).
		const going = this.aims.get(key) ?? (this.openness(key) < 0.5 ? closed : open);
		const to = going === open ? closed : open;
		this.aims.set(key, to);
		this.drive.aim(key, to);
	}

	/** Each joint where the physics has it now, sent somewhere or pushed; true while
	 *  any still moves. */
	update(): boolean {
		const drive = this.drive;
		if (!drive) return false;
		let moving = false;
		for (const key of this.keys()) {
			if (!drive.moving(key)) continue;
			moving = true;
			const v = drive.at(key);
			if (Math.abs(v - this.value(key)) > STILL) this.set(key, v);
		}
		return moving;
	}

	private joint(key: string): { piece: Furniture; part: string; joint: Joint } {
		const j = this.joints.get(key);
		if (!j) throw new Error(`no joint ${key}`);
		return j;
	}
}

/** What moves the joints (`Dynamics`): sends one toward a value, says where it is
 *  and whether it still moves. */
export interface Drive {
	aim(key: string, value: number): void;
	at(key: string): number;
	moving(key: string): boolean;
}

/**
 * The changes of light, joints' or lamps', a bake since the `last` can keep as they
 * were: of one still there (`now`, each with how far it opens, or 1 for a lamp, and
 * the region its light is baked in), at the same value, and whose region no edit
 * reaches (`edited` says if one does). Every other one is baked again.
 */
export function keptChanges(
	last: LightChange[],
	now: { key: string; at: number; region: THREE.Box3 }[],
	edited: (region: THREE.Box3) => boolean,
): Map<string, LightChange> {
	const out = new Map<string, LightChange>();
	for (const j of last) {
		const n = now.find((m) => m.key === j.key);
		if (!n) continue;
		if (n.at !== j.at || edited(n.region)) continue;
		out.set(j.key, j);
	}
	return out;
}
