import { describe, expect, it } from 'vitest';
import { easeExposure } from './exposure';

describe('easeExposure', () => {
	it('goes evenly in stops, most of the way in its adapt time', () => {
		expect(easeExposure(100, 400, 0)).toBeCloseTo(100);
		// After 0.6 s, 1 - 1/e of the two stops between 100 and 400.
		const after = easeExposure(100, 400, 0.6);
		expect(Math.log2(after / 100)).toBeCloseTo(2 * (1 - Math.exp(-1)));
		expect(easeExposure(100, 400, 60)).toBeCloseTo(400);
	});
});
