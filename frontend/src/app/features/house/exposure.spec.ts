import { describe, expect, it } from 'vitest';
import { easeExposure, logAverage } from './exposure';

describe('logAverage', () => {
	it('is the geometric mean of luminance, so one bright window does not swamp the room', () => {
		const grey = (l: number) => [l, l, l, 1];
		expect(logAverage([...grey(0.01), ...grey(0.01)])).toBeCloseTo(0.01);
		// One pixel 100 times brighter than three others raises the mean ~3.2 times, not 25.
		const room = [...grey(0.01), ...grey(0.01), ...grey(0.01), ...grey(1)];
		expect(logAverage(room) / 0.01).toBeCloseTo(Math.pow(100, 1 / 4));
	});
});

describe('easeExposure', () => {
	it('goes evenly in stops, most of the way in its adapt time', () => {
		expect(easeExposure(100, 400, 0)).toBeCloseTo(100);
		// After 0.6 s, 1 - 1/e of the two stops between 100 and 400.
		const after = easeExposure(100, 400, 0.6);
		expect(Math.log2(after / 100)).toBeCloseTo(2 * (1 - Math.exp(-1)));
		expect(easeExposure(100, 400, 60)).toBeCloseTo(400);
	});
});
