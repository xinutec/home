import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BODY } from './walk';

/** Metres the walker keeps clear of what it meets (the controller's offset). */
const GAP = 0.01;
/** The walker: its body and shape (feet to shoulders), and the controller
 *  that moves it. */
interface Walker {
	body: RAPIER.RigidBody;
	shape: RAPIER.Collider;
	controller: RAPIER.KinematicCharacterController;
}
/** Metres a step must be deep, ahead of where the walker stands on its edge, for
 *  it to step up onto it: room for a foot. */
const TREAD = 0.1;
/** Metres the walker drops at most in a frame onto what is under it: down a stair,
 *  or off a ledge. */
const DROP = 3;
/** Seconds a physics step covers: the screen's usual frame. */
const STEP = 1 / 60;
/** Steps at most a frame: a frame late by more drops the rest, not the page. */
const MAX_STEPS = 4;
const FRICTION = 0.8;
/** How much of its speed a thing keeps off a bounce, unless it says. */
const BOUNCE = 0.1;
/** How fast a spin dies away (1/s): a ball on carpet rolls a little, then stops. */
const SPIN_DAMPING = 0.8;
/** Metres deep a door or drawer presses into a thing before it is jammed. */
const JAM = 0.005;
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
 * The walker walks in the same world (`walk`: step and slide, by Rapier's
 * character controller), and what is under its feet is asked of it (`ground`):
 * there is no other copy of the room's shapes.
 */
export class Dynamics {
	private readonly world: RAPIER.World;
	private readonly bodies = new Map<string, RAPIER.RigidBody>();
	private readonly R: typeof RAPIER;
	private left = 0;
	private walker?: Walker;
	/** Each door and drawer: its key, body and shape, a mesh it moves as, and where
	 *  it was last put. */
	private readonly joints: {
		key: string;
		body: RAPIER.RigidBody;
		shape: RAPIER.Collider;
		mesh: THREE.Mesh;
		at: THREE.Matrix4;
		/** How deep it was in a thing when last asked. */
		depth: number;
	}[] = [];

	/** The room as drawn (`meshes`): what moves on a joint (`userData.moves`) a body
	 *  of its own, the rest fixed. */
	constructor(R: typeof RAPIER, meshes: THREE.Mesh[]) {
		this.R = R;
		this.world = new R.World({ x: 0, y: -9.81, z: 0 });
		this.world.timestep = STEP;
		this.world.lengthUnit = LENGTH_UNIT;
		const flags = R.TriMeshFlags.FIX_INTERNAL_EDGES;
		const byJoint = new Map<string, THREE.Mesh[]>();
		const fixed: THREE.Mesh[] = [];
		for (const m of meshes) {
			const key: unknown = m.userData['moves'];
			if (typeof key === 'string') byJoint.set(key, [...(byJoint.get(key) ?? []), m]);
			else fixed.push(m);
		}
		const { vertices, indices } = soup(fixed, (m) => m.matrixWorld);
		this.world.createCollider(R.ColliderDesc.trimesh(vertices, indices, flags));
		// A joint's meshes in its first mesh's frame (placed and turned, not scaled),
		// its body placed and turned as that mesh is, now and as it moves.
		for (const [key, parts] of byJoint) {
			const frame = rigid(parts[0]);
			const toFrame = frame.clone().invert();
			const shut = soup(parts, (m) => toFrame.clone().multiply(m.matrixWorld));
			const p = new THREE.Vector3();
			const q = new THREE.Quaternion();
			frame.decompose(p, q, new THREE.Vector3());
			const body = this.world.createRigidBody(
				R.RigidBodyDesc.kinematicPositionBased()
					.setTranslation(p.x, p.y, p.z)
					.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
			);
			const shape = this.world.createCollider(
				R.ColliderDesc.trimesh(shut.vertices, shut.indices, flags),
				body,
			);
			this.joints.push({
				key,
				body,
				shape,
				mesh: parts[0],
				at: parts[0].matrixWorld.clone(),
				depth: 0,
			});
		}
		this.refresh();
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
		this.refresh();
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

	/** Walks the walker standing at `feet` by `dx`, `dz`, as a game's walker steps
	 *  and slides: the move tried where it stands, and lifted by a step (BODY.low,
	 *  where there is room for a foot) then set down on what is there, the one that goes further kept if it lands on
	 *  something to stand on; then down onto the floor, a stair down or off a ledge.
	 *  It slides along the room and its doors where they stand; what is loose it
	 *  walks into and shoves. Where its feet are then. */
	walk(feet: THREE.Vector3, dx: number, dz: number): THREE.Vector3 {
		const across = { x: dx, y: 0, z: dz };
		const flat = feet.clone().add(this.slide(feet, across).by);
		const up = this.slide(feet, { x: 0, y: BODY.low, z: 0 }).by;
		const length = Math.hypot(dx, dz);
		if (up.y > 0 && length > 0 && this.roomFor(feet.clone().add(up), dx / length, dz / length)) {
			const high = feet.clone().add(up);
			const over = high.clone().add(this.slide(high, across).by);
			const down = this.slide(over, { x: 0, y: -up.y, z: 0 });
			const landed = over.clone().add(down.by);
			const further = (to: THREE.Vector3) => Math.hypot(to.x - feet.x, to.z - feet.z);
			// Set down on a step, it stands there.
			if (down.grounded && further(landed) > further(flat) + 1e-4) {
				this.walkerAt(feet).body.setNextKinematicTranslation(middleOf(landed));
				return landed;
			}
		}
		const to = flat.clone().add(this.slide(flat, { x: 0, y: -DROP, z: 0 }).by);
		// Its body moved there by the next step, as a body moving pushes.
		this.walkerAt(feet).body.setNextKinematicTranslation(middleOf(to));
		return to;
	}

	/** The highest surface under [x, z] below `below`: of the room, its doors where
	 *  they stand now, and the things in it, but the walker. None: nothing is under
	 *  it. */
	// dev-lint: allow-ts-test-only the walker calls it through its Footing (walk.ts)
	ground(x: number, z: number, below: number): number | undefined {
		const R = this.R;
		const down = new R.Ray({ x, y: below, z }, { x: 0, y: -1, z: 0 });
		const hit = this.world.castRay(
			down,
			100,
			true,
			undefined,
			undefined,
			undefined,
			undefined,
			(c) => !this.isWalker(c),
		);
		return hit ? below - hit.timeOfImpact : undefined;
	}

	/** Whether, lifted to `high`, the walker can go a foot's depth (TREAD) on along
	 *  [ux, uz]: a step has room for a foot (a stair's tread), not just its edge (a
	 *  pouf's base under its bulge). */
	private roomFor(high: THREE.Vector3, ux: number, uz: number): boolean {
		const went = this.slide(high, { x: ux * TREAD, y: 0, z: uz * TREAD }).by;
		return Math.hypot(went.x, went.z) >= TREAD * 0.9;
	}

	/** The walker standing at `from` moved `by`, as far as the room and its doors
	 *  let it, sliding along them; and whether it ended standing on something. */
	private slide(from: THREE.Vector3, by: RAPIER.Vector): { by: THREE.Vector3; grounded: boolean } {
		const w = this.walkerAt(from);
		w.controller.computeColliderMovement(
			w.shape,
			by,
			this.R.QueryFilterFlags.EXCLUDE_DYNAMIC,
			undefined,
			(c) => !this.isWalker(c),
		);
		const m = w.controller.computedMovement();
		return { by: new THREE.Vector3(m.x, m.y, m.z), grounded: w.controller.computedGrounded() };
	}

	/** Whether `c` is the walker's own. */
	private isWalker(c: RAPIER.Collider): boolean {
		return !!this.walker && c.parent() === this.walker.body;
	}

	/** Makes what was added findable by the world's queries (the walker's, `ground`):
	 *  they see a collider only once a step has placed it, so a step of no time. */
	private refresh(): void {
		this.world.timestep = 0;
		this.world.step();
		this.world.timestep = STEP;
	}

	/** The walker, made the first time, put to stand at `feet` now (and moving on
	 *  from there, if a walk then sets where to). */
	private walkerAt(feet: THREE.Vector3): Walker {
		const R = this.R;
		if (!this.walker) {
			const body = this.world.createRigidBody(
				R.RigidBodyDesc.kinematicPositionBased().setTranslation(feet.x, middleOf(feet).y, feet.z),
			);
			// Narrower at its feet than its shoulders, as a body is, and flat below: a
			// flat foot lands on a stair's edge (a round one slides back off it), and
			// one narrower than the shoulders that a wall stops does not land on the
			// skirting board along it.
			const ring = (y: number, r: number) =>
				Array.from({ length: 16 }, (_, i) => {
					const turn = (i * Math.PI) / 8;
					return [r * Math.cos(turn), y, r * Math.sin(turn)];
				}).flat();
			const half = (BODY.high - GAP) / 2;
			const hull = R.ColliderDesc.convexHull(
				Float32Array.from([...ring(-half, BODY.foot), ...ring(half, BODY.radius)]),
			);
			if (!hull) throw new Error("the walker's body has no hull");
			const shape = this.world.createCollider(hull, body);
			this.walker = { body, shape, controller: this.world.createCharacterController(GAP) };
		}
		this.walker.body.setTranslation(middleOf(feet), true);
		this.world.propagateModifiedBodyPositionsToColliders();
		return this.walker;
	}

	/** Runs the world `seconds` on, in whole steps; true while anything moves. */
	step(seconds: number): boolean {
		// Each door and drawer to where it is drawn now, by the next step: what it
		// meets, it pushes, and what is in it, it carries.
		for (const j of this.joints) {
			j.mesh.updateMatrixWorld();
			if (j.mesh.matrixWorld.equals(j.at)) continue;
			j.at.copy(j.mesh.matrixWorld);
			const p = new THREE.Vector3();
			const q = new THREE.Quaternion();
			rigid(j.mesh).decompose(p, q, new THREE.Vector3());
			j.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
			j.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
		}
		this.left = Math.min(this.left + seconds, STEP * MAX_STEPS);
		while (this.left >= STEP) {
			this.world.step();
			this.left -= STEP;
		}
		return [...this.bodies.values()].some((b) => !b.isSleeping());
	}

	/** The doors and drawers pressing into a thing they cannot push away (caught
	 *  between them and the room): deeper in it than JAM, and deeper than when last
	 *  asked. One pushed freely moves on within a step, and is never so deep; one
	 *  moving away, though still in it, is not pressing. */
	jammed(): string[] {
		return this.joints
			.filter((j) => {
				let depth = 0;
				this.world.contactPairsWith(j.shape, (other) => {
					if (!other.parent()?.isDynamic()) return;
					this.world.contactPair(j.shape, other, (m) => {
						for (let i = 0; i < m.numContacts(); i++) depth = Math.max(depth, -m.contactDist(i));
					});
				});
				const pressing = depth > JAM && depth > j.depth;
				j.depth = depth;
				return pressing;
			})
			.map((j) => j.key);
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
/** The least share of its radius a ball reaches every way: its faces fall short of
 *  it by little (a low sphere's, 0.9), a box's by much (a cube's, 0.58). */
const BALL_REACH = 0.85;
/** Directions spread evenly over the sphere (a Fibonacci lattice) a thing's outline
 *  is taken in: enough to keep a round body within 5 mm of itself. */
const DIRECTIONS = Array.from({ length: 256 }, (_, i) => {
	const y = 1 - (2 * (i + 0.5)) / 256;
	const r = Math.sqrt(1 - y * y);
	const turn = i * Math.PI * (3 - Math.sqrt(5));
	return new THREE.Vector3(Math.cos(turn) * r, y, Math.sin(turn) * r);
});
/** The axes a thing's flat faces lie square to (a foot, a cushion's side). */
const AXES = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));
/** Metres within which points lie in one flat face. */
const FLAT = 0.001;
/** The corners a flat face keeps: its own, if it has no more; a round foot as a
 *  12-gon, within 3.4% of its radius. A face of dozens of corners, a thing
 *  standing on it rocks and walks off a shelf (a candle in a jar, 3 cm on its own). */
const FACE_CORNERS = 12;

/** The extreme point of `points` (of which `among` the indices) along `d`. */
function furthest(points: Float32Array, among: number[], d: THREE.Vector3): number {
	let [best, at] = [-Infinity, among[0]];
	for (const i of among) {
		const reach = points[i] * d.x + points[i + 1] * d.y + points[i + 2] * d.z;
		if (reach > best) [best, at] = [reach, i];
	}
	return at;
}

/** The corners of a flat face (`face`, indices into `points`) square to `axis`: its
 *  outline's convex hull, by the monotone chain. */
function cornersOf(points: Float32Array, face: number[], axis: THREE.Vector3): number[] {
	const u = new THREE.Vector3(axis.y, axis.z, axis.x);
	const v = axis.clone().cross(u);
	const flat = face
		.map((i) => {
			const p = new THREE.Vector3().fromArray(points, i);
			return { i, x: p.dot(u), y: p.dot(v) };
		})
		.sort((a, b) => a.x - b.x || a.y - b.y);
	type P = (typeof flat)[number];
	const turn = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const half = (pts: P[]) => {
		const out: P[] = [];
		for (const p of pts) {
			while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 1e-9)
				out.pop();
			out.push(p);
		}
		return out.slice(0, -1);
	};
	return [...half(flat), ...half([...flat].reverse())].map((p) => p.i);
}

/** The shape a thing collides as, from its parts' points (its own frame): a ball if
 *  they lie on one, and reach it every way; else the hull of its furthest points in
 *  DIRECTIONS, each flat face square to an axis cut to FACE_CORNERS corners. */
export function collisionShape(
	points: Float32Array,
): { ball: { middle: THREE.Vector3; radius: number } } | { hull: Float32Array } {
	const middle = new THREE.Box3().setFromArray(points).getCenter(new THREE.Vector3());
	const p = new THREE.Vector3();
	let [near, far] = [Infinity, 0];
	for (let i = 0; i < points.length; i += 3) {
		const r = p.fromArray(points, i).distanceTo(middle);
		[near, far] = [Math.min(near, r), Math.max(far, r)];
	}
	const all = Array.from({ length: points.length / 3 }, (_, i) => i * 3);
	// Every way, how far from the middle it reaches: a box's corners lie on a ball,
	// but its faces fall short of it.
	let short = Infinity;
	const outline = new Set<number>();
	for (const d of DIRECTIONS) {
		const at = furthest(points, all, d);
		short = Math.min(short, p.fromArray(points, at).sub(middle).dot(d));
		outline.add(at);
	}
	if (far - near < far * ROUND && short > far * BALL_REACH)
		return { ball: { middle, radius: far } };
	for (const axis of AXES) {
		const along = (i: number) =>
			points[i] * axis.x + points[i + 1] * axis.y + points[i + 2] * axis.z;
		const top = along(furthest(points, all, axis));
		const face = all.filter((i) => along(i) > top - FLAT);
		if (face.length < 3) continue;
		// Its own corners only, round it: the face's every point the outline took goes.
		for (const i of [...outline]) if (along(i) > top - FLAT) outline.delete(i);
		const corners = cornersOf(points, face, axis);
		if (corners.length <= FACE_CORNERS) for (const i of corners) outline.add(i);
		else {
			// Round: its furthest points in FACE_CORNERS headings across it.
			const across = new THREE.Vector3(axis.y, axis.z, axis.x);
			for (let k = 0; k < FACE_CORNERS; k++) {
				const heading = across.clone().applyAxisAngle(axis, (k * 2 * Math.PI) / FACE_CORNERS);
				outline.add(furthest(points, face, heading));
			}
		}
	}
	return {
		hull: Float32Array.from([...outline].flatMap((i) => [points[i], points[i + 1], points[i + 2]])),
	};
}

function shapeOf(R: typeof RAPIER, points: Float32Array): RAPIER.ColliderDesc | null {
	const shape = collisionShape(points);
	if ('ball' in shape) {
		const { middle, radius } = shape.ball;
		return R.ColliderDesc.ball(radius).setTranslation(middle.x, middle.y, middle.z);
	}
	return R.ColliderDesc.convexHull(shape.hull);
}

/** The middle of the walker's body standing at `feet`: it keeps GAP over them. */
function middleOf(feet: THREE.Vector3): { x: number; y: number; z: number } {
	return { x: feet.x, y: feet.y + GAP + (BODY.high - GAP) / 2, z: feet.z };
}

/** Where `m` is in the room, placed and turned but not scaled: a body's frame. */
function rigid(m: THREE.Object3D): THREE.Matrix4 {
	m.updateMatrixWorld();
	const p = new THREE.Vector3();
	const q = new THREE.Quaternion();
	m.matrixWorld.decompose(p, q, new THREE.Vector3());
	return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}

/** `meshes`' triangles, each placed by `place`, as one list of vertices and indices. */
function soup(
	meshes: THREE.Mesh[],
	place: (m: THREE.Mesh) => THREE.Matrix4,
): { vertices: Float32Array; indices: Uint32Array } {
	const vertices: number[] = [];
	const indices: number[] = [];
	const at = new THREE.Vector3();
	for (const m of meshes) {
		m.updateMatrixWorld();
		const matrix = place(m);
		const pos = m.geometry.getAttribute('position');
		const base = vertices.length / 3;
		for (let i = 0; i < pos.count; i++) {
			at.fromBufferAttribute(pos, i).applyMatrix4(matrix);
			vertices.push(at.x, at.y, at.z);
		}
		const index = m.geometry.index;
		if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
		else for (let i = 0; i < pos.count; i++) indices.push(base + i);
	}
	return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}
