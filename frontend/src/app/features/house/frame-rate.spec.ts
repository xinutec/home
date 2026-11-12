import { describe, expect, it } from 'vitest';
import { FrameRate } from './frame-rate';

describe('FrameRate', () => {
	it('says the longest gap between frames shown back to back, and the most work one took', () => {
		const rate = new FrameRate();
		// 120 frames a second for two seconds, each 3 ms of work; one shown 33 ms after
		// the one before it (the GPU behind), though its own work was 3 ms too.
		let t = 0;
		for (let k = 0; k < 240; k++) {
			const gap = k === 200 ? 33 : 1000 / 120;
			t += gap;
			rate.frame(t, 3, gap);
		}
		const r = rate.reading(t);
		expect(r?.fps).toBeGreaterThanOrEqual(115);
		expect(r?.slowest).toBe(33);
		expect(r?.work).toBe(3);
	});

	it('takes no pause between frames for a slow one: it draws only when the view changes', () => {
		const rate = new FrameRate();
		rate.frame(0, 3, undefined);
		// Still for 400 ms, then a tap draws one frame: no gap, as none followed another.
		rate.frame(400, 5, undefined);
		expect(rate.reading(410)).toEqual({ fps: 2, slowest: 5, work: 5 });
	});

	it('says nothing while nothing is drawn', () => {
		const rate = new FrameRate();
		expect(rate.reading(0)).toBeUndefined();
		rate.frame(0, 3, undefined);
		expect(rate.reading(100)).toBeDefined();
		expect(rate.reading(1000)).toBeUndefined();
	});

	it('says the slowest frame the GPU drew in the last second, as its timer reports it later', () => {
		const rate = new FrameRate();
		let t = 0;
		for (let k = 0; k < 60; k++) {
			t += 1000 / 60;
			rate.frame(t, 2, 1000 / 60);
			// The GPU's time for a frame arrives a frame or two after it.
			if (k > 1) rate.gpu(t, k === 30 ? 9 : 3);
		}
		expect(rate.reading(t)?.gpu).toBe(9);
		// No timer, no GPU reading.
		const none = new FrameRate();
		none.frame(0, 2, undefined);
		expect(none.reading(10)?.gpu).toBeUndefined();
	});
});
