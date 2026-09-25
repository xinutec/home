import { Injectable, inject } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import {
	type PagePort,
	type ServiceWorkerPort,
	SwUpdates as SwUpdatePolicy,
	type UpdateOutcome,
} from '@xinutec/ui-harness/sw-updates';
import { filter } from 'rxjs';

export type { UpdateOutcome };

/** Set once we have reloaded out of an unrecoverable service-worker state, so
 *  it happens once. Session storage survives that reload. */
const RECOVERY_KEY = 'home.sw-recovery-attempted';

/**
 * Self-update: Angular's wiring for the policy in `@xinutec/ui-harness/sw-updates`.
 * ngsw only checks for a new build on navigation, and a dashboard left open on
 * a phone never navigates. The service worker caches the app, never the
 * readings (ngsw-config.json has no data groups).
 */
@Injectable({ providedIn: 'root' })
export class SwUpdates {
	private readonly sw = inject(SwUpdate);

	private readonly serviceWorker: ServiceWorkerPort = ((sw: SwUpdate) => ({
		// A getter on `sw`, not a copied boolean: start() needs the live value, and
		// `this` inside an object-literal getter is the literal.
		get isEnabled(): boolean {
			return sw.isEnabled;
		},
		onVersionReady: (handler: () => void): void => {
			sw.versionUpdates
				.pipe(filter((event): event is VersionReadyEvent => event.type === 'VERSION_READY'))
				.subscribe(() => handler());
		},
		onUnrecoverable: (handler: () => void): void => {
			// The cached build is broken and the server no longer has its files;
			// only a fresh load recovers.
			sw.unrecoverable.subscribe(() => handler());
		},
		checkForUpdate: () => sw.checkForUpdate(),
		activateUpdate: () => sw.activateUpdate(),
	}))(this.sw);

	private readonly page: PagePort = {
		get hidden(): boolean {
			return document.visibilityState === 'hidden';
		},
		onVisibilityChange: (handler: () => void): void => {
			document.addEventListener('visibilitychange', handler);
		},
		recoveryAttempted: () => sessionStorage.getItem(RECOVERY_KEY) !== null,
		markRecoveryAttempted: () => sessionStorage.setItem(RECOVERY_KEY, '1'),
		reload: () => this.reload(),
		now: () => Date.now(),
	};

	private readonly policy = new SwUpdatePolicy(this.serviceWorker, this.page);

	start(): void {
		this.policy.start();
	}

	/** Check for an update now. Never rejects: a failure resolves to `'failed'`. */
	checkNow(): Promise<UpdateOutcome> {
		return this.policy.checkNow();
	}

	/** A method so tests can stub it instead of reloading the runner. */
	reload(): void {
		document.location.reload();
	}
}
