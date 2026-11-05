import * as THREE from 'three';
import { partsOf, pieceId } from './assembly';
import type { JointState } from './assembly';
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
	const rest = houseBodies(meshes);
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	const out: string[] = [];
	for (const f of scene.furniture) {
		const piece = pieceId(f);
		const parts = partsOf(f);
		for (const p of parts) {
			if (!p.joint) continue;
			const moved = withChildren(parts, p.id);
			const still = rest.filter(
				(b) => !(b.tag.kind === 'part' && b.tag.piece === piece && moved.has(b.tag.part)),
			);
			const [r0, r1] = p.joint.range;
			const hits = new Set<string>();
			for (let k = 1; k <= SWEEP_STEPS; k++) {
				const state: JointState = { [`${piece}/${p.id}`]: r0 + ((r1 - r0) * k) / SWEEP_STEPS };
				const moving = houseBodies(
					pieceMeshes(stage, scene, f, mats, state).filter((m) => {
						const t = solidTag(m);
						return t?.kind === 'part' && moved.has(t.part);
					}),
				);
				for (const a of moving)
					for (const b of still) {
						const hit = `${a.body.name} into ${b.body.name}`;
						if (hits.has(hit) || !a.body.box.intersectsBox(b.body.box)) continue;
						if (penetration(a.body, b.body, tolerance, true)) hits.add(hit);
					}
			}
			for (const hit of hits) out.push(`opening ${piece}/${p.id}: ${hit}`);
		}
	}
	return out;
}
