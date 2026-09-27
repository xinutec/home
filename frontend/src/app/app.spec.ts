import { SwUpdate } from '@angular/service-worker';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideZonelessChangeDetection(),
				provideRouter([]),
				provideHttpClient(),
				provideHttpClientTesting(),
				// Disabled, as in a dev build: start() then does nothing.
				{ provide: SwUpdate, useValue: { isEnabled: false } },
			],
		}).compileComponents();
	});

	it('should create the app', () => {
		const fixture = TestBed.createComponent(App);
		expect(fixture.componentInstance).toBeTruthy();
	});

	it('names the app in the bar', async () => {
		const fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		await fixture.whenStable();
		const compiled = fixture.nativeElement as HTMLElement;
		expect(compiled.querySelector('ui-scaffold h1')?.textContent).toContain('Home');
	});

	it('lists the two views in the nav menu', () => {
		const app = TestBed.createComponent(App).componentInstance;
		expect(app['nav'].map((n) => n.path)).toEqual(['/environment', '/claude']);
	});
});
