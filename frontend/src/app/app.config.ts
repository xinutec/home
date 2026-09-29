import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
	ErrorHandler,
	type ApplicationConfig,
	isDevMode,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { TelemetryErrorHandler, failedRequestInterceptor } from './error-reporting';

export const appConfig: ApplicationConfig = {
	providers: [
		{ provide: ErrorHandler, useClass: TelemetryErrorHandler },
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes),
		provideHttpClient(withFetch(), withInterceptors([failedRequestInterceptor])),
		provideAnimationsAsync(),
		provideServiceWorker('ngsw-worker.js', {
			enabled: !isDevMode(),
			registrationStrategy: 'registerWhenStable:30000',
		}),
	],
};
