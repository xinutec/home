import { describe, expect, it } from 'vitest';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import * as THREE from 'three';
import { collisions } from './collisions';
import { MaterialLibrary } from './materials';
import { check, TOLERANCE } from './physics';
import { buildHouse } from './room-builder';

// JSON arrays read as number[], not the format's [x, z] pairs; the format is checked
// by these very rules, so the cast is the claim under test.
const scene = json as unknown as HouseScene;
const found = check(scene).map((v) => `${v.kind}: ${v.what}`);

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

	it('finds nothing wrong outside the living room', () => {
		expect(found.filter((v) => !v.includes('living'))).toEqual([]);
	});
});

/**
 * Where two things of the drawn house are in each other, on their real shapes
 * (`collisions.ts`). Each is real, and each is the scene's to settle, not a rule to
 * loosen: fixing one means deleting its line here; a new one anywhere fails.
 */
const KNOWN_COLLISIONS = [
	// The board at the serving hatch, 1.34 m wide, passes through the solid wall
	// either side of the hatch's 0.84 m opening.
	'dining passage × kitchen-serving-worktop/body',
	'dining wall × kitchen-serving-worktop/body',
	'kitchen wall × kitchen-serving-worktop/body',
	// A wall shelf's three dividers run into its back board.
	'kitchen-cubbies-divider/body × kitchen-cubbies-back/body',
	'kitchen-cubbies-left/body × kitchen-cubbies-back/body',
	'kitchen-cubbies-right/body × kitchen-cubbies-back/body',
	// The alcove cupboards, as measured, flush on the back and side walls: through
	// the 2 cm skirting there, on both. Which gives way waits on how they stand.
	'living skirting × living-ikea-cupboard-fireplace-wall/back',
	'living skirting × living-ikea-cupboard-fireplace-wall/bottom',
	'living skirting × living-ikea-cupboard-fireplace-wall/door-a',
	'living skirting × living-ikea-cupboard-fireplace-wall/side-a',
	'living skirting × living-ikea-cupboard-fireplace-wall/side-b',
	'living skirting × living-ikea-cupboard-opposite-wall/back',
	'living skirting × living-ikea-cupboard-opposite-wall/bottom',
	'living skirting × living-ikea-cupboard-opposite-wall/door-b',
	'living skirting × living-ikea-cupboard-opposite-wall/side-b',
].sort();

describe('scenes/house.json, drawn', () => {
	it('has nothing in anything else but the known collisions', () => {
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
		const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
		const hits = collisions(meshes, TOLERANCE).map((c) => `${c.a} × ${c.b}`);
		expect(hits.sort()).toEqual(KNOWN_COLLISIONS);
	}, 60_000);
});
