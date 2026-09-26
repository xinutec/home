import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiService } from '../../api.service';
import type { ClaudeUsage } from '../../measurement.model';
import { UsagePage } from './usage';

const t = Date.parse;

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
		expect(page['live'](28, t('2026-08-04T18:10:00.000Z'))).toBe(28);
	});

	it('withholds a figure whose window has already turned over', () => {
		// Not 28, not 0: there is no such window any more.
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](28, t('2026-08-04T18:10:00.000Z'))).toBeNull();
	});

	it('treats the instant of the reset as already past', () => {
		const page = pageAt('2026-08-04T18:10:00.000Z');
		expect(page['live'](28, t('2026-08-04T18:10:00.000Z'))).toBeNull();
	});

	it('judges each window on its own reset, not on the reading as a whole', () => {
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](28, t('2026-08-04T18:10:00.000Z'))).toBeNull();
		expect(page['live'](66, t('2026-08-07T02:00:00.000Z'))).toBe(66);
	});

	it('says a window has reset rather than that it is resetting now', () => {
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['fmtReset'](t('2026-08-04T18:10:00.000Z'))).toBe('window has reset');
		expect(page['fmtReset'](t('2026-08-05T23:54:00.000Z'))).toBe('resets in 2h 0m');
	});

	it('has nothing to say about a window with no figure or no reset time', () => {
		const page = pageAt('2026-08-05T21:54:00.000Z');
		expect(page['live'](null, t('2026-08-07T02:00:00.000Z'))).toBeNull();
		expect(page['live'](66, null)).toBeNull();
		expect(page['fmtReset'](null)).toBe('');
	});

	async function rendered(usage: ClaudeUsage): Promise<Element> {
		// A stub: the page reads `api.usage` and nothing else.
		TestBed.resetTestingModule();
		await TestBed.configureTestingModule({
			imports: [UsagePage],
			providers: [
				provideZonelessChangeDetection(),
				{ provide: ApiService, useValue: { usage: signal(usage) } },
			],
		}).compileComponents();
		const fixture = TestBed.createComponent(UsagePage);
		await fixture.whenStable();
		const host: unknown = fixture.nativeElement;
		if (!(host instanceof Element)) throw new Error('the page rendered no element');
		return host;
	}

	function reading(models: ClaudeUsage['models']): ClaudeUsage {
		return {
			host: 'mac-mini',
			ts: Date.now(),
			five_hour_pct: 62,
			five_hour_resets_at: Date.now() + 3_600_000,
			seven_day_pct: 87,
			seven_day_resets_at: Date.now() + 34 * 3_600_000,
			measured: true,
			models,
		};
	}

	it("shows a model's own weekly allowance under the model's name", async () => {
		const host = await rendered(
			reading([
				{
					model: 'Fable',
					ts: Date.now(),
					pct: 6,
					resets_at: Date.now() + 34 * 3_600_000,
				},
			]),
		);
		const said = host.textContent ?? '';
		expect(said).toContain('Weekly · Fable');
		expect(said).toContain('6%');
		expect(said).toContain('87%');
		expect(host.querySelectorAll('.cu-card').length).toBe(3);
	});

	it('shows no model card when the account has no scoped window', async () => {
		// Counted: "Weekly ·" also matches the all-models card.
		expect((await rendered(reading([]))).querySelectorAll('.cu-card').length).toBe(2);
	});
});
