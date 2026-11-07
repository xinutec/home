import { describe, expect, it } from 'vitest';
import { partsOf, withModels } from './assembly';
import type { Furniture, HouseScene } from './house.model';

describe('withModels', () => {
	const speaker = {
		size: [0.136, 0.136, 0.3] as [number, number, number],
		material: 'speaker-fabric',
		parts: [
			{
				id: 'body',
				size: [0.136, 0.136, 0.3] as [number, number, number],
				at: [0, 0.068, 0] as [number, number, number],
			},
		],
	};
	const scene = (f: Furniture): HouseScene => ({
		height: 2.4,
		rooms: [],
		furniture: [f],
		models: { speaker },
	});
	const placed: Furniture = {
		id: 'a',
		model: 'speaker',
		cx: 0,
		cz: 0,
		w: 0.3,
		d: 0.136,
		h: 0.136,
		front: '+x',
	};

	it("gives a piece its model's parts and material, its box turned by its front", () => {
		const [f] = withModels(scene(placed)).furniture;
		expect(partsOf(f)).toEqual(speaker.parts);
		expect(f.material).toBe('speaker-fabric');
	});

	it('refuses a piece whose box is not its model’s size, or a model the scene has not', () => {
		expect(() => withModels(scene({ ...placed, front: '+z' }))).toThrow(
			"a's box is not its speaker's size",
		);
		expect(() => withModels(scene({ ...placed, model: 'lamp' }))).toThrow('no model of');
	});
});
