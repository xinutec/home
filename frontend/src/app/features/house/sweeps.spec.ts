import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Furniture, HouseScene, Part, Room } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { stops, sweeps } from './sweeps';

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

/** A scene of `furniture`, drawn, for the sweeps. */
function drawn(furniture: Furniture[]) {
	const scene: HouseScene = { height: 2.4, rooms: [room], furniture };
	const stage = { scene: new THREE.Scene(), own: <T>(x: T) => x };
	const mats = new MaterialLibrary(stage.own, false);
	buildHouse(stage, scene, mats, false, false);
	const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
	return { scene, meshes, mats };
}

/** What each door and drawer runs into in a scene of `furniture`, as drawn. */
function swept(furniture: Furniture[]): string[] {
	const { scene, meshes, mats } = drawn(furniture);
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

	describe('stops', () => {
		const drawer: Part = {
			id: 'drawer',
			size: [0.4, 0.2, 0.3],
			at: [0, 0.5, 0.05],
			joint: { type: 'slide', axis: [0, 0, 1], range: [0, 0.3] },
		};

		it('says nothing of a door or drawer that opens its whole travel', () => {
			// The drawer in the cabinet's right half, the door its left.
			const right: Part = { ...drawer, size: [0.4, 0.2, 0.3], at: [0.25, 0.5, 0.05] };
			const { scene, meshes, mats } = drawn([cabinet([back, door([0, -100]), right])]);
			expect(stops(scene, meshes, mats, 0.002)).toEqual({});
		});

		it('stops a drawer where it meets what stands in front of it', () => {
			// The drawer's front is at z = 0.4, the stool's back at 0.45.
			const stool: Furniture = { id: 'stool', cx: 0, cz: 0.6, w: 0.4, d: 0.3, h: 0.7 };
			const { scene, meshes, mats } = drawn([cabinet([drawer]), stool]);
			const found = stops(scene, meshes, mats, 0.002);
			expect(Object.keys(found)).toEqual(['cab/drawer']);
			expect(found['cab/drawer']).toBeCloseTo(0.05, 2);
		});

		it('stops a door where it swings into what stands beside its cabinet', () => {
			// Hinged at its left edge, x = -1, swinging out past square; a board 5 cm to
			// the left: the door's far edge, 0.5 out, meets it about 6 degrees past.
			const nook: Furniture = { ...cabinet([back, door([0, -120])]), cx: -0.5 };
			const board: Furniture = { id: 'board', cx: -1.1, cz: 1, w: 0.1, d: 2, h: 2 };
			const { scene, meshes, mats } = drawn([nook, board]);
			const found = stops(scene, meshes, mats, 0.002);
			expect(Object.keys(found)).toEqual(['cab/door']);
			expect(found['cab/door']).toBeLessThan(-92);
			expect(found['cab/door']).toBeGreaterThan(-100);
		});
	});
});
