import { describe, expect, it } from 'vitest';
import type { Furniture, HouseScene } from './house.model';
import { boxMaterial, partMaterial, surfaceMaterial } from './materials';

const scene: HouseScene = {
	height: 2.4,
	rooms: [],
	furniture: [],
	materials: { oak: { color: '#c8a878', roughness: 0.55, texture: 'wood' } },
};
const box = (over: Partial<Furniture>): Furniture => ({ cx: 0, cz: 0, w: 1, d: 1, h: 1, ...over });

describe('boxMaterial', () => {
	it("takes the named material from the scene's table", () => {
		expect(boxMaterial(scene, box({ material: 'oak', color: '#000000' }))).toEqual({
			color: '#c8a878',
			roughness: 0.55,
			texture: 'wood',
		});
	});

	it('falls back to the box colour, matt, when it names no material', () => {
		expect(boxMaterial(scene, box({ color: '#181818' }))).toEqual({
			color: '#181818',
			roughness: 0.8,
		});
	});

	it('refuses a material the table does not have, rather than drawing it grey', () => {
		expect(() => boxMaterial(scene, box({ material: 'walnut' }))).toThrow(/walnut/);
	});
});

describe('partMaterial', () => {
	it("takes the part's own material, else its colour, else the piece's", () => {
		const piece = box({ material: 'oak' });
		expect(
			partMaterial(scene, piece, { id: 'a', size: [1, 1, 1], at: [0, 0, 0], color: '#123456' })
				.color,
		).toBe('#123456');
		expect(partMaterial(scene, piece, { id: 'b', size: [1, 1, 1], at: [0, 0, 0] }).color).toBe(
			'#c8a878',
		);
	});
});

describe('surfaceMaterial', () => {
	it('uses the room surface when named, else the default for that surface', () => {
		const room = { start: [0, 0] as [number, number], walls: [], surfaces: { floor: 'oak' } };
		expect(surfaceMaterial(scene, room, 'floor').color).toBe('#c8a878');
		expect(surfaceMaterial(scene, room, 'ceiling').color).toBe('#f4f3ef');
	});
});
