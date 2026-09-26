import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FIVE_HOURS, UsageLevel, WEEK } from './level';

const t = Date.parse;

describe('UsageLevel', () => {
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [UsageLevel],
			providers: [provideZonelessChangeDetection()],
		}).compileComponents();
	});

	function level(inputs: {
		pct?: number | null;
		resetsAt?: number | null;
		takenAt?: number | null;
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
		// The ends are the bar's own edges.
		const marks = level({ pct: 40, span: WEEK })['days']();
		expect(marks.length).toBe(6);
		expect(marks[0]).toBeCloseTo(100 / 7, 6);
		expect(marks[5]).toBeCloseTo(600 / 7, 6);
	});

	it('leaves the five-hour window unmarked', () => {
		expect(level({ pct: 40, span: FIVE_HOURS })['days']()).toEqual([]);
	});

	it('places the clock from the reading, not from the browser', () => {
		// Two days into the week: 2/7, whenever the test runs.
		const level2d = level({
			pct: 40,
			takenAt: t('2026-08-03T00:00:00.000Z'),
			resetsAt: t('2026-08-08T00:00:00.000Z'),
			span: WEEK,
		});
		expect(level2d['clock']()).toBeCloseTo(200 / 7, 6);
	});

	it('clamps a reading that outlived its own window', () => {
		const early = level({
			pct: 3,
			takenAt: t('2026-08-03T00:00:00.000Z'),
			resetsAt: t('2026-08-11T00:00:00.000Z'),
			span: WEEK,
		});
		expect(early['clock']()).toBe(0);
	});

	it('draws no marks when there is no figure behind them', () => {
		const dead = level({
			pct: null,
			takenAt: t('2026-08-03T00:00:00.000Z'),
			resetsAt: t('2026-08-08T00:00:00.000Z'),
			span: WEEK,
		});
		expect(dead['clock']()).toBeNull();
		expect(dead['days']()).toEqual([]);
	});

	it('has no clock when the reading carries no instant to place it at', () => {
		expect(
			level({ pct: 40, resetsAt: null, takenAt: t('2026-08-03T00:00:00.000Z'), span: WEEK })[
				'clock'
			](),
		).toBeNull();
		expect(
			level({ pct: 40, resetsAt: t('2026-08-08T00:00:00.000Z'), takenAt: null, span: WEEK })[
				'clock'
			](),
		).toBeNull();
	});

	it('renders a tick per boundary plus the clock', async () => {
		const fixture = TestBed.createComponent(UsageLevel);
		fixture.componentRef.setInput('pct', 40);
		fixture.componentRef.setInput('takenAt', t('2026-08-03T00:00:00.000Z'));
		fixture.componentRef.setInput('resetsAt', t('2026-08-08T00:00:00.000Z'));
		fixture.componentRef.setInput('span', WEEK);
		await fixture.whenStable();
		const host: unknown = fixture.nativeElement;
		if (!(host instanceof Element)) throw new Error('the level rendered no element');
		expect(host.querySelectorAll('.day').length).toBe(6);
		expect(host.querySelectorAll('.clock').length).toBe(1);
	});
});
