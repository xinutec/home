import { describe, expect, it } from 'vitest';
import { FrameRate } from './frame-rate';

describe('FrameRate', () => {
	it('counts the frames of the last second, and the slowest one’s work', () => {
		const rate = new FrameRate();
		// 60 frames a second for two seconds, each 4 ms of work, one of them 30.
		let t = 0;
		for (let k = 0; k < 120; k++) {
			t += 1000 / 60;
			rate.frame(t, k === 100 ? 30 : 4);
		}
		const r = rate.reading(t);
		expect(r?.fps).toBeGreaterThanOrEqual(59);
		expect(r?.fps).toBeLessThanOrEqual(60);
		expect(r?.slowest).toBe(30);
	});

	it('takes no pause between frames for a slow one: it draws only when the view changes', () => {
		const rate = new FrameRate();
		rate.frame(0, 3);
		// Still for 400 ms, then a tap draws one frame.
		rate.frame(400, 5);
		expect(rate.reading(410)).toEqual({ fps: 2, slowest: 5 });
	});

	it('says nothing while nothing is drawn', () => {
		const rate = new FrameRate();
		expect(rate.reading(0)).toBeUndefined();
		rate.frame(0, 3);
		expect(rate.reading(100)).toBeDefined();
		expect(rate.reading(1000)).toBeUndefined();
	});
});
