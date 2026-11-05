import { describe, expect, it } from 'vitest';
import json from '../../../../../scenes/house.json';
import type { HouseScene } from './house.model';
import * as THREE from 'three';
import { collisions } from './collisions';
import { MaterialLibrary } from './materials';
import { check, TOLERANCE } from './physics';
import { buildHouse } from './room-builder';
import { unsupported } from './support';
import { sweeps } from './sweeps';

// JSON arrays read as number[], not the format's [x, z] pairs; the format is checked
// by these very rules, so the cast is the claim under test.
const scene = json as unknown as HouseScene;
const found = check(scene).map((v) => `${v.kind}: ${v.what}`);

// The scene's own numbers: every part inside its piece's box, every joint closed.
describe('scenes/house.json', () => {
	it('says nothing wrong of itself', () => {
		expect(found).toEqual([]);
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
].sort();

/**
 * Doors that loose furniture stands in front of. They really do not open until it is
 * moved (the bean bag, the armchair), so the physics is right to find them; each is
 * one door and what it meets, however many of its parts.
 */
const BLOCKED_DOORS = [
	'living-ikea-cupboard-fireplace-wall/door-a by living-bean-bag',
	'living-ikea-cupboard-fireplace-wall/door-b by living-bean-bag',
	'living-ikea-cupboard-opposite-wall/door-a by living-armchair',
	'living-ikea-cupboard-opposite-wall/door-b by living-armchair',
].sort();

/** A door's sweep as "door by what it meets": a piece, or a room's surface. */
function blocked(v: string): string {
	const m = /^opening (\S+): \S+ into (.+)$/.exec(v);
	return m ? `${m[1]} by ${m[2].split('/')[0]}` : v;
}

describe('scenes/house.json, drawn', () => {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	const mats = new MaterialLibrary(stage.own, false);
	buildHouse(stage, scene, mats, false, false);
	const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);

	it('has nothing in anything else but the known collisions', () => {
		const hits = collisions(meshes, TOLERANCE).map((c) => `${c.a} × ${c.b}`);
		expect(hits.sort()).toEqual(KNOWN_COLLISIONS);
	}, 60_000);

	it('holds every piece up: resting, hung or fixed, by contact', () => {
		expect(unsupported(meshes).map((u) => `${u.piece}: ${u.why}`)).toEqual([]);
	}, 60_000);

	it('opens every door and drawer into nothing but the known blocked doors', () => {
		const doors = new Set(sweeps(scene, meshes, mats, TOLERANCE).map(blocked));
		expect([...doors].sort()).toEqual(BLOCKED_DOORS);
	}, 60_000);
});
