import * as THREE from 'three';
import { bodyOf, penetration } from './contact';
import type { Body } from './contact';
import { solidTag } from './room-builder';
import type { SolidTag } from './room-builder';

/** Two bodies of the house in each other, by how much. */
export interface Collision {
	a: string;
	b: string;
	depth: number;
}

/** A body's name in a finding: a piece's part, or a room's surface of a kind. */
function nameOf(tag: SolidTag): string {
	return tag.kind === 'part' ? `${tag.piece}/${tag.part}` : `${tag.room ?? 'house'} ${tag.kind}`;
}

/**
 * Every place two things of the drawn house are in each other by more than
 * `tolerance` metres: each part of a piece against every other part and every room
 * surface (walls, floor, ceiling, skirting, coving, window frames and glass, the
 * passages' reveals). Room surfaces meeting each other are the house's own joins,
 * not collisions. `meshes` are `buildHouse`'s, each naming what it is.
 */
// dev-lint: allow-ts-test-only the physics runs ahead of time, in the gate, on the real scene (scene-physics.spec.ts); the page needs none of it
export function collisions(meshes: THREE.Mesh[], tolerance: number): Collision[] {
	const bodies: { body: Body; part: boolean }[] = [];
	for (const m of meshes) {
		const tag = solidTag(m);
		if (!tag) throw new Error('a mesh not made by `buildHouse`');
		const hasInside = tag.kind === 'part' ? !tag.sheet : tag.kind !== 'passage';
		bodies.push({ body: bodyOf(nameOf(tag), m, hasInside), part: tag.kind === 'part' });
	}
	// One finding a pair of names, at its deepest: a wall is drawn as several panels.
	const deepest = new Map<string, Collision>();
	for (let i = 0; i < bodies.length; i++)
		for (let j = i + 1; j < bodies.length; j++) {
			const [a, b] = [bodies[i], bodies[j]];
			if (!a.part && !b.part) continue;
			const near = a.body.box.clone().expandByScalar(tolerance);
			if (!near.intersectsBox(b.body.box)) continue;
			const depth = penetration(a.body, b.body, tolerance);
			if (!depth) continue;
			const key = `${a.body.name}|${b.body.name}`;
			const was = deepest.get(key);
			if (!was || depth > was.depth) deepest.set(key, { a: a.body.name, b: b.body.name, depth });
		}
	return [...deepest.values()];
}
