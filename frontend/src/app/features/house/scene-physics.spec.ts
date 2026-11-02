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
	'wall: @-3.11,2.97,1/body through dining wall 0',
	'wall: @-3.11,2.97,1/body through kitchen wall 5',
	// A wall shelf's three dividers run 2-3 cm into its back board.
	'overlap: @-3.65,2.965,2.01/body and @-3.06,2.815,2.01/body overlap by 20 mm',
	'overlap: @-3.06,2.965,2.01/body and @-3.06,2.815,2.01/body overlap by 30 mm',
	'overlap: @-2.47,2.965,2.01/body and @-3.06,2.815,2.01/body overlap by 20 mm',
	// A thin plate at 0.77 m touches nothing below or behind.
	'support: @-4.085,5.135,0.77 is held up by nothing (bottom at 0.77 m)',
];

// The real scene, held to the physics: what is in the house must be able to be there.
describe('scenes/house.json physics', () => {
	it('finds nothing wrong in the living room', () => {
		expect(found.filter((v) => v.includes('living'))).toEqual([]);
	});

	it('finds exactly the known kitchen findings, no new ones', () => {
		expect(found).toEqual(KNOWN_KITCHEN);
	});
});
