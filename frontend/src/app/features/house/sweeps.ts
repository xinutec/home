import * as THREE from 'three';
import { partsOf, pieceId } from './assembly';
import { houseBodies } from './collisions';
import { penetration } from './contact';
import type { HouseScene, Part } from './house.model';
import type { MaterialLibrary } from './materials';
import { pieceMeshes, solidTag } from './room-builder';

/** Places sampled along each joint's travel, the open end included. */
const SWEEP_STEPS = 12;

/** The part and everything fixed to it, by id. */
export function withChildren(parts: Part[], id: string): Set<string> {
	const out = new Set([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const p of parts) {
			if (p.parent && out.has(p.parent) && !out.has(p.id)) {
				out.add(p.id);
				grew = true;
			}
		}
	}
	return out;
}

/** Halvings of a sweep step that finds where a door or drawer first meets something:
 *  a twelfth of the travel over 2^10, under a tenth of a millimetre or a degree. */
const STOP_HALVINGS = 10;

/** One joint of the drawn house, ready to be drawn anywhere along its travel. */
interface Swept {
	key: string;
	range: [number, number];
	/** What it is in at `v`, as `part into other`, skipping what `skip` holds. */
	meets(v: number, skip?: Set<string>): string[];
}

/** Every joint of the drawn house, each against everything else drawn at rest. */
function joints(
	scene: HouseScene,
	meshes: THREE.Mesh[],
	mats: MaterialLibrary,
	tolerance: number,
): Swept[] {
	const rest = houseBodies(meshes);
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	const out: Swept[] = [];
	for (const f of scene.furniture) {
		const piece = pieceId(f);
		const parts = partsOf(f);
		for (const p of parts) {
			if (!p.joint) continue;
			const moved = withChildren(parts, p.id);
			const still = rest.filter(
				(b) => !(b.tag.kind === 'part' && b.tag.piece === piece && moved.has(b.tag.part)),
			);
			const key = `${piece}/${p.id}`;
			const meets = (v: number, skip = new Set<string>()) => {
				const moving = houseBodies(
					pieceMeshes(stage, scene, f, mats, { [key]: v }).filter((m) => {
						const t = solidTag(m);
						return t?.kind === 'part' && moved.has(t.part);
					}),
				);
				const hits: string[] = [];
				for (const a of moving)
					for (const b of still) {
						const hit = `${a.body.name} into ${b.body.name}`;
						if (skip.has(hit) || !a.body.box.intersectsBox(b.body.box)) continue;
						if (penetration(a.body, b.body, tolerance, true)) hits.push(hit);
					}
				return hits;
			};
			out.push({ key, range: p.joint.range, meets });
		}
	}
	return out;
}

/**
 * What each door and drawer of the drawn house runs into as it opens: the part and
 * what is fixed to it, drawn at SWEEP_STEPS places along its joint's travel, against
 * everything else as drawn at rest (its own piece's other parts, the walls, the
 * skirting, other pieces), deeper than `tolerance`. One line a door and what it
 * meets: `opening piece/part: moving into other`; whether it meets it, not how deep,
 * so a pair found once is not looked for again further along.
 * `meshes` are `buildHouse`'s; `mats` makes the moving parts' meshes.
 */
// dev-lint: allow-ts-test-only the physics runs ahead of time, in the gate, on the real scene (scene-physics.spec.ts); the page needs none of it
export function sweeps(
	scene: HouseScene,
	meshes: THREE.Mesh[],
	mats: MaterialLibrary,
	tolerance: number,
): string[] {
	const out: string[] = [];
	for (const j of joints(scene, meshes, mats, tolerance)) {
		const [r0, r1] = j.range;
		const hits = new Set<string>();
		for (let k = 1; k <= SWEEP_STEPS; k++)
			for (const hit of j.meets(r0 + ((r1 - r0) * k) / SWEEP_STEPS, hits)) hits.add(hit);
		for (const hit of hits) out.push(`opening ${j.key}: ${hit}`);
	}
	return out;
}

/**
 * Where each door and drawer of the drawn house stops, opening, because it meets
 * something (as `sweeps` finds it, then halved down to where): its joint's value
 * there, by `piece/part`. A joint that opens its whole travel is not in it.
 */
// dev-lint: allow-ts-test-only the stops are found ahead of time, in the gate, and written into the scene (scene-physics.spec.ts)
export function stops(
	scene: HouseScene,
	meshes: THREE.Mesh[],
	mats: MaterialLibrary,
	tolerance: number,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const j of joints(scene, meshes, mats, tolerance)) {
		const [r0, r1] = j.range;
		const at = (k: number) => r0 + ((r1 - r0) * k) / SWEEP_STEPS;
		let k = 1;
		while (k <= SWEEP_STEPS && j.meets(at(k)).length === 0) k++;
		if (k > SWEEP_STEPS) continue;
		let [clear, hit] = [at(k - 1), at(k)];
		for (let h = 0; h < STOP_HALVINGS; h++) {
			const mid = (clear + hit) / 2;
			if (j.meets(mid).length === 0) clear = mid;
			else hit = mid;
		}
		out[j.key] = clear;
	}
	return out;
}
