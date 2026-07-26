import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EnvironmentPage } from './environment';

describe('EnvironmentPage', () => {
	beforeEach(async () => {
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

	it('shortId shows only the distinguishing Govee suffix, other ids whole', () => {
		const page = TestBed.createComponent(EnvironmentPage).componentInstance;
		expect(page['shortId']('govee-A562')).toBe('A562');
		expect(page['shortId']('airvisual')).toBe('airvisual');
	});
});
