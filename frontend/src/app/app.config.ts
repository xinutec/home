import { provideHttpClient, withFetch } from '@angular/common/http';
import {
	type ApplicationConfig,
	isDevMode,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes),
		provideHttpClient(withFetch()),
		provideAnimationsAsync(),
		provideServiceWorker('ngsw-worker.js', {
			enabled: !isDevMode(),
			registrationStrategy: 'registerWhenStable:30000',
		}),
	],
};
