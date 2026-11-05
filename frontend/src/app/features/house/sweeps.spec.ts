import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Furniture, HouseScene, Part, Room } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { sweeps } from './sweeps';

// A 6 × 4 m room, its first wall on z = 0, facing +z into the room.
const room: Room = {
	name: 'test',
	start: [-3, 0],
	walls: [
		[0, 6],
		[90, 4],
		[90, 6],
		[90, 4],
	],
};

/** What each door and drawer runs into in a scene of `furniture`, as drawn. */
function swept(furniture: Furniture[]): string[] {
	const scene: HouseScene = { height: 2.4, rooms: [room], furniture };
	const stage = { scene: new THREE.Scene(), own: <T>(x: T) => x };
	const mats = new MaterialLibrary(stage.own, false);
	buildHouse(stage, scene, mats, false, false);
	const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
	return sweeps(scene, meshes, mats, 0.002);
}

// A 1 m wide cabinet against the wall, facing +z into the room: its back and a door.
const back: Part = { id: 'back', size: [1, 0.8, 0.02], at: [0, 0.4, -0.19] };
const cabinet = (parts: Part[]): Furniture => ({
	id: 'cab',
	cx: 0,
	cz: 0.2,
	w: 1,
	d: 0.4,
	h: 0.8,
	parts,
});
const door = (range: [number, number]): Part => ({
	id: 'door',
	size: [0.5, 0.6, 0.02],
	at: [-0.25, 0.4, 0.19],
	joint: { type: 'hinge', pivot: [-0.5, 0.4, 0.2], range },
});

describe('sweeps', () => {
	it('passes a cabinet whose door swings out to the front', () => {
		expect(swept([cabinet([back, door([0, -100])])])).toEqual([]);
	});

	it('catches a door hinged the wrong way, swinging through its own cabinet and the wall', () => {
		expect(swept([cabinet([back, door([0, 100])])])).toEqual([
			'opening cab/door: cab/door into cab/back',
			'opening cab/door: cab/door into test wall',
		]);
	});

	it('catches a drawer that would hit a piece standing in front of it', () => {
		const drawer: Part = {
			id: 'drawer',
			size: [0.4, 0.2, 0.3],
			at: [0, 0.5, 0.05],
			joint: { type: 'slide', axis: [0, 0, 1], range: [0, 0.3] },
		};
		const stool: Furniture = { id: 'stool', cx: 0, cz: 0.6, w: 0.4, d: 0.3, h: 0.7 };
		expect(swept([cabinet([drawer]), stool])).toEqual([
			'opening cab/drawer: cab/drawer into stool/body',
		]);
	});
});
