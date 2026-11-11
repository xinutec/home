import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameParts, SLOW_MS, SlowFrames } from './frame-parts';

describe('FrameParts', () => {
	it('gives each part the time since the last mark, a name marked twice adding up', () => {
		const p = new FrameParts();
		p.begin(100);
		p.mark('walk', 102);
		p.mark('physics', 112);
		p.mark('walk', 113);
		expect(p.end(120)).toEqual({ ms: 20, parts: { walk: 3, physics: 10, other: 7 } });
	});
});

describe('SlowFrames', () => {
	afterEach(() => vi.useRealTimers());

	it('sends the frames over SLOW_MS every ten seconds, with how many were drawn', () => {
		vi.useFakeTimers();
		const sent: { body: unknown; leaving: boolean }[] = [];
		const s = new SlowFrames('living', (body, leaving) =>
			sent.push({ body: JSON.parse(body), leaving }),
		);
		s.frame(5, { draw: 5 });
		s.frame(SLOW_MS + 11.04, { meter: 27.46, draw: 3.58 });
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
		expect(sent[0].leaving).toBe(false);
		expect(sent[0].body).toMatchObject({
			frames: 2,
			slow: [{ room: 'living', ms: 31, parts: { meter: 27.5, draw: 3.6 } }],
		});
		// Nothing drawn since: nothing sent.
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
		s.frame(40, { physics: 40 });
		s.dispose();
		expect(sent[1].leaving).toBe(true);
	});
});
