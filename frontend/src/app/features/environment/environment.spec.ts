import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EnvironmentPage } from './environment';

describe('EnvironmentPage', () => {
	beforeEach(async () => {
		// The preferences persist, so one test's toggle would leak into the next.
		localStorage.clear();
		await TestBed.configureTestingModule({
			imports: [EnvironmentPage],
			providers: [
				provideZonelessChangeDetection(),
				provideHttpClient(),
				provideHttpClientTesting(),
			],
		}).compileComponents();
	});

	it('has a "Show IDs" preference, off by default, that toggles', () => {
		const page = TestBed.createComponent(EnvironmentPage).componentInstance;
		expect(page['showIds']()).toBe(false);
		page['toggleShowIds']();
		expect(page['showIds']()).toBe(true);
	});

	it('spends no row above the readings on a display preference', async () => {
		const fixture = TestBed.createComponent(EnvironmentPage);
		await fixture.whenStable();
		const el = fixture.nativeElement as HTMLElement;
		expect(el.querySelector('mat-slide-toggle')).toBeNull();
		expect(el.querySelector('.rooms-head button[aria-label="Display options"]')).not.toBeNull();
	});

	it('offers both display preferences as checkable items, showing their state', async () => {
		const fixture = TestBed.createComponent(EnvironmentPage);
		await fixture.whenStable();
		const el = fixture.nativeElement as HTMLElement;
		el.querySelector<HTMLButtonElement>('button[aria-label="Display options"]')!.click();
		await fixture.whenStable();
		const items = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
		expect(
			items.map((i) => [
				i.querySelector('span')?.textContent?.trim(),
				i.getAttribute('aria-checked'),
			]),
		).toEqual([
			['Calibrated', 'true'],
			['Show IDs', 'false'],
		]);
	});

	it('marks the readings uncalibrated only while calibration is off', async () => {
		const fixture = TestBed.createComponent(EnvironmentPage);
		await fixture.whenStable();
		const el = fixture.nativeElement as HTMLElement;
		expect(el.querySelector('.hero .uncalibrated')).toBeNull();
		fixture.componentInstance['toggleCalibrated']();
		await fixture.whenStable();
		expect(el.querySelector('.hero .uncalibrated')?.textContent).toContain('Uncalibrated');
	});

	it('shortId shows only the distinguishing Govee suffix, other ids whole', () => {
		const page = TestBed.createComponent(EnvironmentPage).componentInstance;
		expect(page['shortId']('govee-A562')).toBe('A562');
		expect(page['shortId']('airvisual')).toBe('airvisual');
	});
});
