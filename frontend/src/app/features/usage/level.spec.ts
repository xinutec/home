import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FIVE_HOURS, UsageLevel, WEEK } from './level';

/**
 * A percentage says how much is gone, never whether that is a lot for how far
 * in the window is. These two marks supply the missing half: the day ticks give
 * the bar a unit, and the clock mark says where the window's own clock stood at
 * the moment the figure was captured.
 *
 * The instant is the part worth testing. Both halves have to come from one
 * reading — placing the mark from the browser's clock would make a stale bar
 * appear to fall further behind pace the longer the page sat open, which is the
 * same false reading `live()` exists to prevent one level up.
 */
describe('UsageLevel', () => {
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [UsageLevel],
			providers: [provideZonelessChangeDetection()],
		}).compileComponents();
	});

	function level(inputs: {
		pct?: number | null;
		resetsAt?: string | null;
		takenAt?: string | null;
		span: number;
	}): UsageLevel {
		const fixture = TestBed.createComponent(UsageLevel);
		fixture.componentRef.setInput('pct', inputs.pct ?? null);
		fixture.componentRef.setInput('resetsAt', inputs.resetsAt ?? null);
		fixture.componentRef.setInput('takenAt', inputs.takenAt ?? null);
		fixture.componentRef.setInput('span', inputs.span);
		return fixture.componentInstance;
	}

	it('marks the six day boundaries inside a week', () => {
		// Six, not seven or eight: the ends are the bar's own edges, and a tick
		// drawn on them would say a boundary is there twice.
		const marks = level({ pct: 40, span: WEEK })['days']();
		expect(marks.length).toBe(6);
		expect(marks[0]).toBeCloseTo(100 / 7, 6);
		expect(marks[5]).toBeCloseTo(600 / 7, 6);
	});

	it('leaves the five-hour window unmarked', () => {
		// Ticks are for judging pace across a week. Five hours has no unit a
		// person tracks, so marks there would be decoration.
		expect(level({ pct: 40, span: FIVE_HOURS })['days']()).toEqual([]);
	});

	it('places the clock from the reading, not from the browser', () => {
		// Read two days into the week: the mark belongs at 2/7, whenever this
		// test happens to run.
		const level2d = level({
			pct: 40,
			takenAt: '2026-08-03T00:00:00.000Z',
			resetsAt: '2026-08-08T00:00:00.000Z',
			span: WEEK,
		});
		expect(level2d['clock']()).toBeCloseTo(200 / 7, 6);
	});

	it('clamps a reading that outlived its own window', () => {
		// A machine reporting just after a turnover carries a reset further out
		// than the window is long. Off the bar is worse than nowhere.
		const early = level({
			pct: 3,
			takenAt: '2026-08-03T00:00:00.000Z',
			resetsAt: '2026-08-11T00:00:00.000Z',
			span: WEEK,
		});
		expect(early['clock']()).toBe(0);
	});

	it('draws no marks when there is no figure behind them', () => {
		// The page withholds a percentage whose window has turned over. A clock
		// mark over an empty bar would invite exactly the comparison that
		// withholding exists to prevent.
		const dead = level({
			pct: null,
			takenAt: '2026-08-03T00:00:00.000Z',
			resetsAt: '2026-08-08T00:00:00.000Z',
			span: WEEK,
		});
		expect(dead['clock']()).toBeNull();
		expect(dead['days']()).toEqual([]);
	});

	it('has no clock when the reading carries no instant to place it at', () => {
		expect(
			level({ pct: 40, resetsAt: null, takenAt: '2026-08-03T00:00:00.000Z', span: WEEK })[
				'clock'
			](),
		).toBeNull();
		expect(
			level({ pct: 40, resetsAt: '2026-08-08T00:00:00.000Z', takenAt: null, span: WEEK })[
				'clock'
			](),
		).toBeNull();
	});

	it('renders a tick per boundary plus the clock', async () => {
		const fixture = TestBed.createComponent(UsageLevel);
		fixture.componentRef.setInput('pct', 40);
		fixture.componentRef.setInput('takenAt', '2026-08-03T00:00:00.000Z');
		fixture.componentRef.setInput('resetsAt', '2026-08-08T00:00:00.000Z');
		fixture.componentRef.setInput('span', WEEK);
		await fixture.whenStable();
		const host: unknown = fixture.nativeElement;
		if (!(host instanceof Element)) throw new Error('the level rendered no element');
		expect(host.querySelectorAll('.day').length).toBe(6);
		expect(host.querySelectorAll('.clock').length).toBe(1);
	});
});
