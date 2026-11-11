import { describe, expect, it } from 'vitest';
import { balanceFor } from './image-stage';

describe('balanceFor', () => {
	const y = (rgb: number[]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
	// 2700 K, about 1, 0.62 and 0.32 of red in linear light; an overcast sky.
	const lamp: [number, number, number] = [1, 0.62, 0.32];
	const daylight: [number, number, number] = [0.86, 0.91, 1];

	it('makes a warm lamp’s light the daylight’s colour, as bright as it was', () => {
		const gain = balanceFor(lamp, daylight);
		const seen = lamp.map((c, i) => c * gain[i]);
		expect(seen[0] / seen[1]).toBeCloseTo(daylight[0] / daylight[1]);
		expect(seen[2] / seen[1]).toBeCloseTo(daylight[2] / daylight[1]);
		expect(y(seen)).toBeCloseTo(y(lamp));
	});

	it('leaves the daylight as it is, at any brightness', () => {
		const dim = daylight.map((c) => c * 0.1);
		for (const g of balanceFor([dim[0], dim[1], dim[2]], daylight)) expect(g).toBeCloseTo(1);
	});

	it('balances nothing where there is no light, or no daylight to balance to', () => {
		expect(balanceFor([0, 0, 0], daylight)).toEqual([1, 1, 1]);
		expect(balanceFor(lamp, [0, 0, 0])).toEqual([1, 1, 1]);
	});
});
