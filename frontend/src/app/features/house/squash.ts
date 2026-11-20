import * as THREE from 'three';

/** How a soft thing gives (`Movable.give`, `Movable.recover`): metres for each
 *  kilogram laid on it, and the seconds it takes to come most of the way back. */
export interface Soft {
	give: number;
	recover: number;
}

/** The most a soft thing gives, as a share of its thickness: a cushion under a
 *  heavy thing is flat, not gone. */
export const MOST = 0.4;
/** Seconds a soft thing takes to go most of the way down under a load: it gives
 *  as the load comes on, and comes back slower (`Soft.recover`). */
export const PRESS = 0.06;
/** Metres from where its load puts it that a soft thing is at rest within. */
const STILL = 1e-4;
const G = 9.81;

/**
 * How far a soft thing is pressed in: it follows its load, down fast and back in
 * its own time, without swinging past (a cushion does not ring). Only what is
 * drawn gives: the thing's body in the physics keeps its shape, so a pile of soft
 * things stands as still as a pile of hard ones.
 */
export class Squash {
	/** Metres its far side is down, toward what it lies on. */
	depth = 0;

	constructor(private readonly soft: Soft) {}

	/** `seconds` on under `load` newtons through `thickness` metres of it; true
	 *  while it still moves. */
	step(load: number, thickness: number, seconds: number): boolean {
		const to = Math.min(MOST * thickness, (this.soft.give * load) / G);
		const time = to > this.depth ? PRESS : this.soft.recover;
		// The share of the way left after `seconds`: the same over one frame or two.
		this.depth = to + (this.depth - to) * Math.exp(-seconds / time);
		if (Math.abs(this.depth - to) < STILL) {
			this.depth = to;
			return false;
		}
		return true;
	}

	/** A blow of `momentum` (newton seconds: a weight times the speed it landed at)
	 *  through `thickness` of it: it dents at once by what it gives for the push that
	 *  stops that in the time it takes to go down, and comes back from there. */
	hit(momentum: number, thickness: number): void {
		const dent = (this.soft.give * momentum) / PRESS / G;
		this.depth = Math.min(MOST * thickness, this.depth + dent);
	}
}

/**
 * A thing pressed in by `depth` along `way` (a unit vector in its own frame, from
 * what it lies on into it): the side it lies on, `foot` along `way`, stays; the
 * rest comes toward it, `thickness` of it losing `depth`; and it bulges across by
 * what keeps its volume.
 */
export function squashMatrix(
	way: THREE.Vector3,
	foot: number,
	thickness: number,
	depth: number,
): THREE.Matrix4 {
	if (depth <= 0) return new THREE.Matrix4();
	const along = 1 - depth / thickness;
	const across = 1 / Math.sqrt(along);
	// across · 1 + (along - across) · way wayᵀ, about the point `foot` along `way`.
	const k = along - across;
	const { x, y, z } = way;
	const move = foot * (1 - along);
	return new THREE.Matrix4().set(
		across + k * x * x,
		k * x * y,
		k * x * z,
		move * x,
		k * y * x,
		across + k * y * y,
		k * y * z,
		move * y,
		k * z * x,
		k * z * y,
		across + k * z * z,
		move * z,
		0,
		0,
		0,
		1,
	);
}

/**
 * The newtons each thing is pressed together by, from who holds whom up (`on`,
 * by key) and what each weighs (`kg`): half its own weight (its foot bears all of
 * it, its top none) and all of what lies on it, the pile above shared evenly among
 * what holds it. From the weights, not the world's pushes: these are right at rest
 * and still (`Press`).
 */
export function loads(
	on: ReadonlyMap<string, readonly string[]>,
	kg: (key: string) => number,
): Map<string, number> {
	const carried = new Map<string, number>([...on.keys()].map((key) => [key, 0]));
	// A thing's weight and what it carries go to what holds it up, the top of a pile
	// first: a thing is passed down once all that lies on it has been.
	const above = new Map<string, number>([...on.keys()].map((key) => [key, 0]));
	for (const under of on.values()) for (const u of under) above.set(u, (above.get(u) ?? 0) + 1);
	const ready = [...on.keys()].filter((key) => above.get(key) === 0);
	for (let key = ready.pop(); key !== undefined; key = ready.pop()) {
		const under = on.get(key) ?? [];
		for (const u of under) {
			carried.set(u, (carried.get(u) ?? 0) + (kg(key) + (carried.get(key) ?? 0)) / under.length);
			above.set(u, (above.get(u) ?? 1) - 1);
			if (above.get(u) === 0) ready.push(u);
		}
	}
	return new Map([...carried].map(([key, weight]) => [key, (kg(key) / 2 + weight) * G]));
}

/**
 * How far each thing is drawn below where the physics has it: what holds it up
 * (`on`, by key) has given under it (`drop`, the fall of a thing's top), and what
 * holds that up, all the way down. Of several holding it, the one that has sunk
 * most. Two leaning on each other end the walk.
 */
export function sinks(
	on: ReadonlyMap<string, readonly string[]>,
	drop: (key: string) => number,
): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (key: string, seen: Set<string>): number => {
		const known = out.get(key);
		if (known !== undefined) return known;
		if (seen.has(key)) return 0;
		seen.add(key);
		let most = 0;
		for (const under of on.get(key) ?? []) most = Math.max(most, walk(under, seen) + drop(under));
		seen.delete(key);
		out.set(key, most);
		return most;
	};
	for (const key of on.keys()) walk(key, new Set());
	return out;
}
