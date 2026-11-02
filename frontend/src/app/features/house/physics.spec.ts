import { describe, expect, it } from 'vitest';
import { corners, solidsOf } from './assembly';
import type { Solid } from './assembly';
import type { Furniture, HouseScene, Part } from './house.model';
import { check, penetration } from './physics';

const box = (over: Partial<Solid>): Solid => ({
	piece: 'p',
	part: 'b',
	x: 0,
	z: 0,
	yaw: 0,
	hw: 0.5,
	hd: 0.5,
	y0: 0,
	y1: 1,
	...over,
});

describe('penetration', () => {
	it('is zero for boxes that only touch, and the overlap depth when they meet', () => {
		expect(penetration(box({}), box({ x: 1 }))).toBe(0);
		expect(penetration(box({}), box({ x: 0.99 }))).toBeCloseTo(0.01);
	});

	it('sees an overlap between turned boxes, and none where turning clears them', () => {
		// A 1 m square turned 45° reaches 0.707 m along x.
		expect(penetration(box({}), box({ x: 1.15, yaw: Math.PI / 4 }))).toBeGreaterThan(0);
		expect(penetration(box({}), box({ x: 1.25, yaw: Math.PI / 4 }))).toBe(0);
	});

	it('is zero when the heights do not overlap', () => {
		expect(penetration(box({}), box({ y0: 1, y1: 2 }))).toBe(0);
	});
});

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
const back: Part = { id: 'back', size: [1, 0.8, 0.02], at: [0, 0.4, -0.19] };

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
	it('passes a cabinet whose door swings out to the front', () => {
		const door: Part = {
			id: 'door',
			size: [0.5, 0.6, 0.02],
			at: [-0.25, 0.4, 0.19],
			joint: { type: 'hinge', pivot: [-0.5, 0.4, 0.2], range: [0, -100] },
		};
		expect(check(scene([cabinet([back, door])]))).toEqual([]);
	});

	it('catches a door hinged the wrong way, swinging into its own cabinet', () => {
		const door: Part = {
			id: 'door',
			size: [0.5, 0.6, 0.02],
			at: [-0.25, 0.4, 0.19],
			joint: { type: 'hinge', pivot: [-0.5, 0.4, 0.2], range: [0, 100] },
		};
		const kinds = check(scene([cabinet([back, door])])).map((v) => v.kind);
		expect(kinds).toContain('sweep');
	});

	it('catches a drawer that would hit a piece standing in front of it', () => {
		const drawer: Part = {
			id: 'drawer',
			size: [0.4, 0.2, 0.3],
			at: [0, 0.5, 0.05],
			joint: { type: 'slide', axis: [0, 0, 1], range: [0, 0.3] },
		};
		const stool: Furniture = { id: 'stool', cx: 0, cz: 0.6, w: 0.4, d: 0.3, h: 0.7 };
		const v = check(scene([cabinet([drawer]), stool]));
		expect(v.some((x) => x.kind === 'sweep' && x.what.includes('stool'))).toBe(true);
	});

	it('catches two pieces in one place, and a part outside its piece', () => {
		const a: Furniture = { id: 'a', cx: 0, cz: 1, w: 1, d: 1, h: 1 };
		const b: Furniture = { id: 'b', cx: 0.5, cz: 1, w: 1, d: 1, h: 1 };
		expect(check(scene([a, b])).map((v) => v.kind)).toContain('overlap');
		const loose: Part = { id: 'shelf', size: [1.2, 0.02, 0.3], at: [0, 0.5, 0] };
		expect(check(scene([cabinet([loose])])).map((v) => v.kind)).toContain('envelope');
	});

	it('catches a part through a wall', () => {
		const deep: Part = { id: 'deep', size: [0.5, 0.5, 0.6], at: [0, 0.25, -0.1] };
		const v = check(scene([cabinet([deep], { cz: 0.2, d: 0.8 })]));
		expect(v.some((x) => x.kind === 'wall')).toBe(true);
	});

	it('holds a curtain by the pole it hangs from, and not without one', () => {
		const pole: Furniture = { id: 'pole', cx: 0, cz: 1, w: 6, d: 0.03, h: 0.03, y0: 2.15 };
		const curtain: Furniture = { id: 'curtain', cx: 1, cz: 1, w: 0.35, d: 0.03, h: 1.75, y0: 0.4 };
		expect(check(scene([pole, curtain]))).toEqual([]);
		expect(check(scene([curtain])).map((v) => v.what)).toEqual([
			'curtain is held up by nothing (bottom at 0.4 m)',
		]);
	});

	it('holds a piece up by the floor, by what it stands on, or by the wall it is on, and nothing else', () => {
		const floating: Furniture = { id: 'f', cx: 0, cz: 2, w: 0.5, d: 0.5, h: 0.2, y0: 1 };
		expect(check(scene([floating])).map((v) => v.kind)).toEqual(['support']);
		const onWall: Furniture = { id: 'tv', cx: 0, cz: 0.025, w: 1, d: 0.05, h: 0.6, y0: 1.2 };
		const onTop: Furniture = { id: 'lamp', cx: 0, cz: 0.2, w: 0.2, d: 0.2, h: 0.3, y0: 0.8 };
		expect(check(scene([cabinet([back]), onWall, onTop]))).toEqual([]);
	});
});
