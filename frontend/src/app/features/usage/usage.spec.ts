import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UsagePage } from './usage';

/**
 * A percentage belongs to a window. When the window turns over the figure goes
 * back to nothing, so a reading taken before the turn describes a window that no
 * longer exists — and drawing it is a claim about the account that is not true.
 *
 * This is the ordinary case rather than a corner of it: the reading arrives from
 * a machine that may have gone quiet, so "the window this described has already
 * reset" is what a stale feed looks like. Measured 2026-08-05T21:54Z, home was
 * showing 28% for a five-hour window that ended 27 hours earlier, captioned
 * "resets now", while the account's true weekly figure was 92% against the 66%
 * on screen. The same rule already governs the console's copy —
 * see `Window.resets_in_ms` in memview's `console/src/usage.rs`.
 */
describe('UsagePage', () => {
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [UsagePage],
			providers: [
				provideZonelessChangeDetection(),
				provideHttpClient(),
				provideHttpClientTesting(),
			],
		}).compileComponents();
	});

	function pageAt(now: string): UsagePage {
		const page = TestBed.createComponent(UsagePage).componentInstance;
		page['now'].set(new Date(now).getTime());
		return page;
	}

	it('shows a figure while its window is still open', () => {
		const page = pageAt('2026-08-04T17:10:00.000Z');
		expect(page['live'](28, '2026-08-04T18:10:00.000Z')).toBe(28);
	});

	it('withholds a figure whose window has already turned over', () => {
		// The real reading home served: 28%, for a window that ended at 18:10 the
		// previous day. Not 28, not 0 — nothing, because there is no such window.
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](28, '2026-08-04T18:10:00.000Z')).toBeNull();
	});

	it('treats the instant of the reset as already past', () => {
		// "Not in the future" and "in the past" differ by exactly this case, and
		// the figure is worth nothing at it.
		const page = pageAt('2026-08-04T18:10:00.000Z');
		expect(page['live'](28, '2026-08-04T18:10:00.000Z')).toBeNull();
	});

	it('judges each window on its own reset, not on the reading as a whole', () => {
		// The five-hour window dies while the week it sits inside is still live —
		// so a single "is this reading stale" flag would throw away a true figure.
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](28, '2026-08-04T18:10:00.000Z')).toBeNull();
		expect(page['live'](66, '2026-08-07T02:00:00.000Z')).toBe(66);
	});

	it('says a window has reset rather than that it is resetting now', () => {
		// The old caption for a dead window was "resets now", which reads as
		// something about to happen and dressed a day-old figure as current.
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['fmtReset']('2026-08-04T18:10:00.000Z')).toBe('window has reset');
		expect(page['fmtReset']('2026-08-05T23:54:00.000Z')).toBe('resets in 2h 0m');
	});

	it('has nothing to say about a window with no figure or no reset time', () => {
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](null, '2026-08-07T02:00:00.000Z')).toBeNull();
		expect(page['live'](66, null)).toBeNull();
		expect(page['fmtReset'](null)).toBe('');
	});
});
