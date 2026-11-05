import { describe, expect, it } from 'vitest';
import { corners, solidsOf } from './assembly';
import type { Furniture, HouseScene, Part } from './house.model';
import { check } from './physics';

// A 1 m wide cabinet against the wall at z = 0, facing +z into the room.
const room = {
	name: 'test',
	start: [-3, 0] as [number, number],
	walls: [
		[0, 6],
		[90, 4],
		[90, 6],
		[90, 4],
	] as [number, number][],
};
const scene = (furniture: Furniture[]): HouseScene => ({ height: 2.4, rooms: [room], furniture });
const cabinet = (parts: Part[], over: Partial<Furniture> = {}): Furniture => ({
	id: 'cab',
	cx: 0,
	cz: 0.2,
	w: 1,
	d: 0.4,
	h: 0.8,
	parts,
	...over,
});

describe('placement', () => {
	it('swings a door hinged on its left, with a negative range, out to the front', () => {
		const door: Part = {
			id: 'door',
			size: [0.5, 0.6, 0.02],
			at: [-0.25, 0.4, 0.19],
			joint: { type: 'hinge', pivot: [-0.5, 0.4, 0.2], range: [0, -90] },
		};
		const open = solidsOf(cabinet([door]), { 'cab/door': -90 })[0];
		// Open 90°: on edge at the hinge line, its 2 cm thickness just inside it
		// (x -0.50..-0.48), reaching its 0.5 m width out into the room.
		expect(open.x).toBeCloseTo(-0.49, 2);
		expect(open.z).toBeCloseTo(0.2 + 0.2 + 0.25, 2);
	});

	it('turns a piece facing +x, so its front looks along +x', () => {
		const drawer: Part = { id: 'drawer', size: [0.4, 0.2, 0.3], at: [0, 0.5, 0.05] };
		const s = solidsOf(cabinet([drawer], { front: '+x', w: 0.4, d: 1 }))[0];
		expect(s.x).toBeCloseTo(0.05);
		expect(s.z).toBeCloseTo(0.2);
		const xs = corners(s).map(([x]) => x);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.3);
	});

	it('moves a knob with the drawer it is fixed to', () => {
		const parts: Part[] = [
			{
				id: 'drawer',
				size: [0.4, 0.2, 0.3],
				at: [0, 0.5, 0.05],
				joint: { type: 'slide', axis: [0, 0, 1], range: [0, 0.25] },
			},
			{ id: 'knob', size: [0.03, 0.03, 0.02], at: [0, 0.5, 0.21], parent: 'drawer' },
		];
		const knob = solidsOf(cabinet(parts), { 'cab/drawer': 0.25 })[1];
		expect(knob.z).toBeCloseTo(0.2 + 0.21 + 0.25);
	});
});

describe('check', () => {
	it('catches a part outside its piece, and a joint not drawn closed', () => {
		const loose: Part = { id: 'shelf', size: [1.2, 0.02, 0.3], at: [0, 0.5, 0] };
		expect(check(scene([cabinet([loose])])).map((v) => v.kind)).toEqual(['envelope']);
		const ajar: Part = {
			id: 'door',
			size: [0.5, 0.6, 0.02],
			at: [-0.25, 0.4, 0.19],
			joint: { type: 'hinge', pivot: [-0.5, 0.4, 0.2], range: [10, -100] },
		};
		// Drawn ajar, it also sticks out of its box.
		expect(check(scene([cabinet([ajar])])).map((v) => v.what)).toContain(
			'cab/door range starts at 10, not closed (0)',
		);
	});
});
