import { corners, partsOf, pieceId, solidsOf } from './assembly';
import type { HouseScene } from './house.model';

/**
 * What the scene must say of itself, checked on its numbers: every part inside its
 * piece's envelope, every joint's range starting closed. What the house does in
 * space (two things in one place, what holds each piece up, what a door meets as it
 * opens) is checked on the drawn shapes: `collisions.ts`, `support.ts`, `sweeps.ts`.
 *
 * Touching is allowed: a sideboard stands against its wall, a knob on its drawer.
 * Only a penetration deeper than TOLERANCE counts, there and here.
 */
export const TOLERANCE = 0.002; // metres

export interface Violation {
	kind: 'envelope' | 'joint';
	what: string;
}

export function check(scene: HouseScene): Violation[] {
	const out: Violation[] = [];
	for (const f of scene.furniture) {
		const piece = pieceId(f);
		// Closed, every part sits inside the piece's envelope.
		const x0 = f.cx - f.w / 2;
		const x1 = f.cx + f.w / 2;
		const z0 = f.cz - f.d / 2;
		const z1 = f.cz + f.d / 2;
		const ey0 = f.y0 ?? 0;
		for (const s of solidsOf(f)) {
			const outside =
				corners(s).some(
					([x, z]) =>
						x < x0 - TOLERANCE || x > x1 + TOLERANCE || z < z0 - TOLERANCE || z > z1 + TOLERANCE,
				) ||
				s.y0 < ey0 - TOLERANCE ||
				s.y1 > ey0 + f.h + TOLERANCE;
			if (outside)
				out.push({ kind: 'envelope', what: `${s.piece}/${s.part} sticks out of ${piece}'s box` });
		}
		// A joint's range starts where its part is drawn: closed.
		for (const p of partsOf(f)) {
			if (p.joint && p.joint.range[0] !== 0)
				out.push({
					kind: 'joint',
					what: `${piece}/${p.id} range starts at ${p.joint.range[0]}, not closed (0)`,
				});
		}
	}
	return out;
}
