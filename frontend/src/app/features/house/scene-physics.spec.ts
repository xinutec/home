import { describe, expect, it } from 'vitest';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import { check } from './physics';

// JSON arrays read as number[], not the format's [x, z] pairs; the format is checked
// by these very rules, so the cast is the claim under test.
const scene = json as unknown as HouseScene;
const found = check(scene).map((v) => `${v.kind}: ${v.what}`);

/**
 * What the physics finds in the kitchen. Each is real, and each is
 * the kitchen's to settle, not a rule to loosen: fixing one means deleting its
 * line here; a new finding anywhere fails.
 */
const KNOWN_KITCHEN = [
	// The board at the serving hatch, 1.34 m wide, passes through the solid wall
	// either side of the hatch's 0.84 m opening.
	'wall: kitchen-serving-worktop/body through dining wall 0',
	'wall: kitchen-serving-worktop/body through kitchen wall 5',
	// A wall shelf's three dividers run 2-3 cm into its back board.
	'overlap: kitchen-cubbies-left/body and kitchen-cubbies-back/body overlap by 20 mm',
	'overlap: kitchen-cubbies-divider/body and kitchen-cubbies-back/body overlap by 30 mm',
	'overlap: kitchen-cubbies-right/body and kitchen-cubbies-back/body overlap by 20 mm',
];

/**
 * Doors in the living room that loose furniture stands in front of. They really do
 * not open until it is moved (the bean bag, the armchair), so the physics is right
 * to find them; each is one door and what blocks it, however many parts it touches.
 */
const BLOCKED_LIVING = [
	'living-ikea-cupboard-fireplace-wall/door-a by living-bean-bag',
	'living-ikea-cupboard-fireplace-wall/door-b by living-bean-bag',
	'living-ikea-cupboard-opposite-wall/door-a by living-armchair',
	'living-ikea-cupboard-opposite-wall/door-b by living-armchair',
];

/** A sweep into another piece, as "door by piece"; anything else, undefined. */
function blocked(v: string): string | undefined {
	const m = /^sweep: opening (\S+): \S+ into ([^/\s]+)\//.exec(v);
	return m ? `${m[1]} by ${m[2]}` : undefined;
}

// The real scene, held to the physics: what is in the house must be able to be there.
describe('scenes/house.json physics', () => {
	const living = found.filter((v) => v.includes('living'));

	it('finds nothing wrong in the living room but the doors furniture blocks', () => {
		expect(living.filter((v) => !blocked(v))).toEqual([]);
		expect([...new Set(living.map(blocked))].sort()).toEqual(BLOCKED_LIVING);
	});

	it('finds exactly the known kitchen findings, no new ones', () => {
		expect(found.filter((v) => !v.includes('living'))).toEqual(KNOWN_KITCHEN);
	});
});
