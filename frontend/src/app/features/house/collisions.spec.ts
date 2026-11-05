import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Furniture, HouseScene, Room } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { collisions } from './collisions';

// A 6 × 4 m room, its first wall on z = 0, facing +z into the room.
const room = (over: Partial<Room> = {}): Room => ({
	name: 'test',
	start: [-3, 0],
	walls: [
		[0, 6],
		[90, 4],
		[90, 6],
		[90, 4],
	],
	...over,
});

/** What collides in a scene of `furniture` in `room`, as drawn. */
function found(furniture: Furniture[], r: Room = room()): string[] {
	const scene: HouseScene = { height: 2.4, rooms: [r], furniture };
	const stage = { scene: new THREE.Scene(), own: <T>(x: T) => x };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
	return collisions(meshes, 0.002).map((c) => `${c.a} × ${c.b}`);
}

const box = (id: string, cx: number, cz: number, over: Partial<Furniture> = {}): Furniture => ({
	id,
	cx,
	cz,
	w: 1,
	d: 0.4,
	h: 0.8,
	...over,
});

describe('collisions', () => {
	it('finds nothing for pieces on the floor, against the wall and side by side', () => {
		expect(found([box('a', 0, 0.2), box('b', 1, 0.2)])).toEqual([]);
	});

	it('catches two pieces in one place', () => {
		expect(found([box('a', 0, 0.2), box('b', 0.5, 0.2)])).toEqual(['a/body × b/body']);
	});

	it('catches a piece through a wall', () => {
		expect(found([box('a', 0, 0.15)])).toEqual(['test wall × a/body']);
	});

	it('catches a piece pushed into the skirting, and not one standing on its face', () => {
		const skirted = room({ skirting: { height: 0.17, depth: 0.02 } });
		expect(found([box('a', 0, 0.2)], skirted)).toEqual(['test skirting × a/body']);
		expect(found([box('a', 0, 0.22)], skirted)).toEqual([]);
	});

	it('catches a piece sunk into the floor, and not one resting on it', () => {
		expect(found([box('a', 0, 1, { y0: -0.01 })])).toEqual(['test floor × a/body']);
		expect(found([box('a', 0, 1, { y0: 0 })])).toEqual([]);
	});
});
