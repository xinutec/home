import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BODY } from './walk';

/** Metres over its feet the walker's body starts: its feet kick what is on the
 *  floor, where its walk steps over a rug (`BODY.low`). */
const FEET = 0.03;
/** Seconds a physics step covers: the screen's usual frame. */
const STEP = 1 / 60;
/** Steps at most a frame: a frame late by more drops the rest, not the page. */
const MAX_STEPS = 4;
const FRICTION = 0.8;
/** How much of its speed a thing keeps off a bounce, unless it says. */
const BOUNCE = 0.1;
/** How fast a spin dies away (1/s): a ball on carpet rolls a little, then stops. */
const SPIN_DAMPING = 0.8;
/** Metres the physics' tolerances scale by: the size of most things in it. At its
 *  default, a metre, a 25 cm cabinet rocked on its foot and walked off a shelf. */
const LENGTH_UNIT = 0.1;

/** Rapier, its WebAssembly started: done when first needed, as most visits never
 *  pick anything up. */
export async function loadRapier(): Promise<typeof RAPIER> {
	await RAPIER.init();
	return RAPIER;
}

/**
 * Things that can be picked up, as rigid bodies under gravity among the fixed room:
 * the room one triangle mesh (its doors as they stand shut), each thing a ball or
 * a hull round its parts (`shapeOf`). A held thing follows the hand (`hold`), and let go keeps the
 * hand's speed (`release`); then it falls, tumbles, and comes to rest, and sleeps.
 * The walker is a body too (`walk`), its column (`BODY`, down to its feet)
 * following it, pushing what it walks into.
 */
export class Dynamics {
	private readonly world: RAPIER.World;
	private readonly bodies = new Map<string, RAPIER.RigidBody>();
	private readonly R: typeof RAPIER;
	private left = 0;
	private walker?: RAPIER.RigidBody;

	constructor(R: typeof RAPIER, fixed: THREE.Mesh[]) {
		this.R = R;
		this.world = new R.World({ x: 0, y: -9.81, z: 0 });
		this.world.timestep = STEP;
		this.world.lengthUnit = LENGTH_UNIT;
		const { vertices, indices } = soup(fixed);
		this.world.createCollider(
			R.ColliderDesc.trimesh(vertices, indices, R.TriMeshFlags.FIX_INTERNAL_EDGES),
		);
	}

	/** Adds `key` as it stands: `object`'s place and turn, its parts' points (in its
	 *  own frame) for its shape, its weight and bounce. Awake, it settles where it
	 *  stands and falls asleep: made asleep, it would have no contact with what is
	 *  under it, and woken, it would fall through a thin shelf before one came. */
	add(
		key: string,
		object: THREE.Object3D,
		points: Float32Array,
		how: { kg: number; bounce?: number },
	): void {
		const R = this.R;
		const hull = shapeOf(R, points);
		if (!hull) throw new Error(`${key}'s parts have no hull`);
		const { x, y, z } = object.position;
		const q = object.quaternion;
		const body = this.world.createRigidBody(
			R.RigidBodyDesc.dynamic()
				.setTranslation(x, y, z)
				.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
				.setAngularDamping(SPIN_DAMPING),
		);
		this.world.createCollider(
			hull
				.setMass(how.kg)
				.setFriction(FRICTION)
				.setRestitution(how.bounce ?? BOUNCE),
			body,
		);
		this.bodies.set(key, body);
	}

	/** Takes `key` in hand: from now it goes where `follow` puts it. */
	hold(key: string): void {
		this.body(key).setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
	}

	/** Moves a held thing to `at`, turned `turn`, by the next step. */
	follow(key: string, at: THREE.Vector3, turn: THREE.Quaternion): void {
		const body = this.body(key);
		body.setNextKinematicTranslation({ x: at.x, y: at.y, z: at.z });
		body.setNextKinematicRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w });
	}

	/** Lets `key` go, moving as the hand moved it. */
	release(key: string): void {
		const body = this.body(key);
		const v = body.linvel();
		body.setBodyType(this.R.RigidBodyType.Dynamic, true);
		body.setLinvel(v, true);
	}

	/** Moves the walker's column to stand at `feet` by the next step. */
	walk(feet: THREE.Vector3): void {
		const R = this.R;
		// Its column: a capsule from FEET over its feet to BODY.high.
		const middle = feet.y + (FEET + BODY.high) / 2;
		if (!this.walker) {
			this.walker = this.world.createRigidBody(
				R.RigidBodyDesc.kinematicPositionBased().setTranslation(feet.x, middle, feet.z),
			);
			const half = (BODY.high - FEET) / 2 - BODY.radius;
			this.world.createCollider(R.ColliderDesc.capsule(half, BODY.radius), this.walker);
		}
		this.walker.setNextKinematicTranslation({ x: feet.x, y: middle, z: feet.z });
	}

	/** Runs the world `seconds` on, in whole steps; true while anything moves. */
	step(seconds: number): boolean {
		this.left = Math.min(this.left + seconds, STEP * MAX_STEPS);
		while (this.left >= STEP) {
			this.world.step();
			this.left -= STEP;
		}
		return [...this.bodies.values()].some((b) => !b.isSleeping());
	}

	/** Where `key` is now: its place and turn into `object`. */
	pose(key: string, object: THREE.Object3D): void {
		const body = this.body(key);
		const t = body.translation();
		const r = body.rotation();
		object.position.set(t.x, t.y, t.z);
		object.quaternion.set(r.x, r.y, r.z, r.w);
	}

	dispose(): void {
		this.world.free();
	}

	private body(key: string): RAPIER.RigidBody {
		const b = this.bodies.get(key);
		if (!b) throw new Error(`no body ${key}`);
		return b;
	}
}

/** How far a ball's points may lie from one radius, as a share of it. */
const ROUND = 0.03;
/** The directions a thing's outline is taken in: 8 headings round, each level,
 *  45° up and down, and a degree off straight up and down, which picks out the rim
 *  of a flat foot or top; and straight up and down. */
const DIRECTIONS = [
	new THREE.Vector3(0, 1, 0),
	new THREE.Vector3(0, -1, 0),
	...[0, 45, -45, 89, -89].flatMap((up) =>
		Array.from({ length: 8 }, (_, i) =>
			new THREE.Vector3().setFromSphericalCoords(1, ((90 - up) * Math.PI) / 180, (i * Math.PI) / 4),
		),
	),
];

/** The shape a thing collides as, from its parts' points (its own frame): a ball if
 *  they lie on one, and reach it every way; else the hull of its furthest point in
 *  each of DIRECTIONS. A box keeps its corners; a round foot becomes an octagon.
 *  The hull of every point gives a round foot dozens of corners, and a thing on one
 *  rocks and walks off a shelf (a candle in a jar, 3 cm on its own). */
function shapeOf(R: typeof RAPIER, points: Float32Array): RAPIER.ColliderDesc | null {
	const middle = new THREE.Box3().setFromArray(points).getCenter(new THREE.Vector3());
	const p = new THREE.Vector3();
	let [near, far] = [Infinity, 0];
	for (let i = 0; i < points.length; i += 3) {
		const r = p.fromArray(points, i).distanceTo(middle);
		[near, far] = [Math.min(near, r), Math.max(far, r)];
	}
	const outline: number[] = [];
	// Every way, how far from the middle it reaches: a box's corners lie on a ball,
	// but its faces fall short of it.
	let short = Infinity;
	for (const d of DIRECTIONS) {
		let [best, at] = [-Infinity, 0];
		for (let i = 0; i < points.length; i += 3) {
			const reach = p.fromArray(points, i).sub(middle).dot(d);
			if (reach > best) [best, at] = [reach, i];
		}
		short = Math.min(short, best);
		outline.push(points[at], points[at + 1], points[at + 2]);
	}
	const round = far - near < far * ROUND && short > far * (1 - ROUND);
	if (round) return R.ColliderDesc.ball(far).setTranslation(middle.x, middle.y, middle.z);
	return R.ColliderDesc.convexHull(Float32Array.from(outline));
}

/** `meshes`' triangles where they stand, as one list of vertices and indices. */
function soup(meshes: THREE.Mesh[]): { vertices: Float32Array; indices: Uint32Array } {
	const vertices: number[] = [];
	const indices: number[] = [];
	const at = new THREE.Vector3();
	for (const m of meshes) {
		m.updateMatrixWorld();
		const pos = m.geometry.getAttribute('position');
		const base = vertices.length / 3;
		for (let i = 0; i < pos.count; i++) {
			at.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
			vertices.push(at.x, at.y, at.z);
		}
		const index = m.geometry.index;
		if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
		else for (let i = 0; i < pos.count; i++) indices.push(base + i);
	}
	return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}
