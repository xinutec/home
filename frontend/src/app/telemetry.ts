import { DOCUMENT, Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { TelemetryCore } from '@xinutec/ui-harness/telemetry';
import { filter } from 'rxjs';

/**
 * Angular binding for the fleet's activity trace; the rest is
 * `@xinutec/ui-harness/telemetry`. It cannot ship this class: the package is
 * built with plain `tsc`, and an `@Injectable` compiled that way fails a
 * production build with "JIT compiler unavailable".
 */
@Injectable({ providedIn: 'root' })
export class Telemetry {
	private readonly router = inject(Router);
	private readonly doc = inject(DOCUMENT);
	private readonly core = new TelemetryCore(this.doc);

	/** Idempotent. */
	init(): void {
		if (this.core.started) return;

		this.router.events
			.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
			.subscribe((e) => this.core.record('nav', e.urlAfterRedirects, null));

		// Capture phase, so the tap is seen even where a handler stops propagation.
		this.doc.addEventListener('click', (ev) => this.core.recordTap(ev.target, this.router.url), {
			capture: true,
		});

		this.core.start();
	}
}
