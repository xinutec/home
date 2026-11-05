import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Furniture, HouseScene, Room } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import { convexHull, unsupported } from './support';

// A 6 × 4 m room, 2.4 m tall, its first wall on z = 0, facing +z into the room.
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

/** Which pieces nothing holds in a scene of `furniture`, as drawn. */
function unheld(furniture: Furniture[]): string[] {
	const scene: HouseScene = { height: 2.4, rooms: [room], furniture };
	const stage = { scene: new THREE.Scene(), own: <T>(x: T) => x };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	const meshes = stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
	return unsupported(meshes).map((u) => `${u.piece}: ${u.why}`);
}

const piece = (id: string, over: Partial<Furniture>): Furniture => ({
	id,
	cx: 0,
	cz: 2,
	w: 0.5,
	d: 0.5,
	h: 0.5,
	...over,
});

describe('unsupported', () => {
	it('holds a piece on the floor, and one on top of it', () => {
		expect(unheld([piece('table', {}), piece('lamp', { w: 0.2, d: 0.2, y0: 0.5 })])).toEqual([]);
	});

	it('finds a piece in the air, and what stands on it with it', () => {
		expect(unheld([piece('shelf', { y0: 1 }), piece('vase', { w: 0.1, d: 0.1, y0: 1.5 })])).toEqual(
			[
				'shelf: it rests on, hangs from and is fixed to nothing that is held',
				'vase: it rests on, hangs from and is fixed to nothing that is held',
			],
		);
	});

	it('finds a piece that overhangs what it rests on past its centre of mass', () => {
		// A board 1 m long, 0.6 m of it beyond the stool it lies on.
		const stool = piece('stool', { w: 0.4, d: 0.4 });
		expect(unheld([stool, piece('board', { cx: 0.6, w: 1, d: 0.3, h: 0.02, y0: 0.5 })])).toEqual([
			'board: its centre of mass is not over where it rests',
		]);
		expect(unheld([stool, piece('board', { cx: 0.2, w: 1, d: 0.3, h: 0.02, y0: 0.5 })])).toEqual(
			[],
		);
	});

	it('lets a soft piece settle over the edge of what it rests on, and only a soft one', () => {
		// A bag 5 mm up on the corner of a mat, most of it over the bare floor.
		const mat = piece('mat', { cx: -0.5, cz: 1.5, w: 1, d: 1, h: 0.005 });
		const bag = piece('bag', { cx: 0.15, cz: 2.15, h: 0.4, y0: 0.005 });
		expect(unheld([mat, bag])).toEqual(['bag: its centre of mass is not over where it rests']);
		expect(unheld([mat, { ...bag, soft: true }])).toEqual([]);
	});

	it('holds a piece fixed to the wall, in the air', () => {
		expect(unheld([piece('tv', { cz: 0.025, w: 1, d: 0.05, h: 0.6, y0: 1.2 })])).toEqual([]);
		expect(unheld([piece('tv', { cz: 0.035, w: 1, d: 0.05, h: 0.6, y0: 1.2 })])).toEqual([
			'tv: it rests on, hangs from and is fixed to nothing that is held',
		]);
	});

	it('holds a light by the ceiling and a curtain by its pole, and neither without', () => {
		const light = piece('light', { w: 0.35, d: 0.35, h: 0.12, y0: 2.28 });
		expect(unheld([light])).toEqual([]);
		expect(unheld([{ ...light, y0: 2.2 }])).toEqual([
			'light: it rests on, hangs from and is fixed to nothing that is held',
		]);
		const pole = piece('pole', { cz: 0.1, w: 6, d: 0.03, h: 0.03, y0: 2.15 });
		const curtain = piece('curtain', { cx: 1, cz: 0.1, w: 0.35, d: 0.03, h: 1.75, y0: 0.4 });
		// The pole is held by its ends, on the walls either side.
		expect(unheld([pole, curtain])).toEqual([]);
		expect(unheld([curtain])).toEqual([
			'curtain: it rests on, hangs from and is fixed to nothing that is held',
		]);
	});
});

describe('convexHull', () => {
	it('keeps the corners, anticlockwise, and drops what is inside', () => {
		expect(
			convexHull([
				[0, 0],
				[1, 0],
				[0.5, 0.5],
				[1, 1],
				[0, 1],
			]),
		).toEqual([
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		]);
	});
});
