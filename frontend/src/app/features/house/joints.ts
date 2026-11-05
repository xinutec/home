import * as THREE from 'three';
import { partsOf, pieceId, solidsOf } from './assembly';
import type { JointState, Solid } from './assembly';
import type { Furniture, HouseScene, Joint } from './house.model';

/** Milliseconds a joint takes over its whole travel: a door swung, a drawer pulled. */
const TRAVEL_MS = 700;

/** A joint on its way: from a value, to one, starting when, for how long. */
interface Run {
	from: number;
	to: number;
	start: number;
	ms: number;
}

/** A solid's place in the room, as a matrix. */
function pose(s: Solid): THREE.Matrix4 {
	return new THREE.Matrix4().makeRotationY(s.yaw).setPosition(s.x, (s.y0 + s.y1) / 2, s.z);
}

/** Eased in and out: a hand starts and stops a door gently. */
function ease(t: number): number {
	return t * t * (3 - 2 * t);
}

/**
 * The doors and drawers of the drawn house, opened and shut. Each moves as the
 * meshes `mergeStatic` keeps for its joint (`userData.moves`), drawn at rest where
 * they stand shut: a joint's value places them by the move its part makes from
 * there, as the physics places the part (`solidsOf`). One opens to its stop, where
 * it meets something (as the gate found it), else its travel's end.
 */
export class Joints {
	private readonly state: JointState = {};
	private readonly runs = new Map<string, Run>();
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

	/** Opens a joint that is shut or shutting, shuts one that is open or opening. */
	toggle(key: string, now: number): void {
		const { range } = this.joint(key).joint;
		const [closed, open] = [range[0], this.openAt(key)];
		const run = this.runs.get(key);
		const from = this.value(key);
		const opening = run ? run.to !== open : from === closed;
		const to = opening ? open : closed;
		const ms = (TRAVEL_MS * Math.abs(to - from)) / Math.abs(range[1] - range[0]);
		this.runs.set(key, { from, to, start: now, ms });
	}

	/** Moves every joint on its way to where it is at `now`; true while any still moves. */
	update(now: number): boolean {
		for (const [key, run] of this.runs) {
			const t = run.ms > 0 ? Math.min(1, (now - run.start) / run.ms) : 1;
			this.set(key, t >= 1 ? run.to : run.from + (run.to - run.from) * ease(Math.max(0, t)));
			if (t >= 1) this.runs.delete(key);
		}
		return this.runs.size > 0;
	}

	private joint(key: string): { piece: Furniture; part: string; joint: Joint } {
		const j = this.joints.get(key);
		if (!j) throw new Error(`no joint ${key}`);
		return j;
	}
}
