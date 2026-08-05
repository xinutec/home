import { DecimalPipe } from '@angular/common';
import { Component, type OnDestroy, type OnInit, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api.service';
import { RelativeTimePipe } from '../../relative-time.pipe';

/**
 * The `/claude` route: Claude Code subscription-usage bars (5-hour window +
 * weekly·all-models), fed by a machine's statusLine push to `/api/usage`. The
 * figures are Anthropic's account-wide rate-limit utilisation. Read-only — the
 * data layer is polled by the shell, this page just renders the freshest row.
 */
@Component({
	selector: 'app-usage',
	imports: [
		DecimalPipe,
		MatCardModule,
		MatIconModule,
		MatProgressBarModule,
		MatTooltipModule,
		RelativeTimePipe,
	],
	templateUrl: './usage.html',
	styleUrl: './usage.scss',
})
export class UsagePage implements OnInit, OnDestroy {
	private readonly api = inject(ApiService);
	protected readonly usage = this.api.usage;

	// Ticks every 30s so the "as of" stamp and reset countdowns keep updating.
	protected readonly now = signal(Date.now());
	private nowTimer: ReturnType<typeof setInterval> | null = null;

	ngOnInit(): void {
		this.nowTimer ??= setInterval(() => this.now.set(Date.now()), 30_000);
	}

	ngOnDestroy(): void {
		if (this.nowTimer !== null) {
			clearInterval(this.nowTimer);
			this.nowTimer = null;
		}
	}

	/**
	 * A window's figure, or `null` once that window has turned over.
	 *
	 * ⚠ **A percentage belongs to a window.** When the window resets the figure
	 * goes back to nothing, so a reading taken before the turn describes a window
	 * that no longer exists — and drawing it is a claim about the account that is
	 * not true. This is the ordinary case rather than a corner of it: the row
	 * comes from a machine that may have gone quiet, and a quiet machine's last
	 * reading ages past its own window within hours.
	 *
	 * Measured 2026-08-05: this page showed 28% for a five-hour window that had
	 * ended 27 hours earlier, captioned "resets now", while the true weekly
	 * figure was 92% against the 66% on screen. Nothing said so, because a stale
	 * gauge looks exactly like a current one. The console's copy of the same
	 * number already works this way — `Window.resets_in_ms` in memview's
	 * `console/src/usage.rs`.
	 *
	 * Judged per window, never per reading: the five hours can be long dead while
	 * the week containing it is still live, and one staleness flag over the row
	 * would throw away a figure that is true.
	 */
	protected live(pct: number | null, iso: string | null): number | null {
		if (pct == null || !iso) {
			return null;
		}
		return new Date(iso).getTime() > this.now() ? pct : null;
	}

	/**
	 * Human "resets in Xh Ym" for a rate-limit window's reset instant. Reads the
	 * `now()` tick so the countdown updates as time passes; empty when there's no
	 * reset time (window absent from the snapshot).
	 *
	 * ⚠ Past the reset this says the window **has** reset, not that it is
	 * resetting "now". The old wording read as something about to happen, which
	 * is precisely how a day-old figure got to look current.
	 */
	protected fmtReset(iso: string | null): string {
		if (!iso) {
			return '';
		}
		const ms = new Date(iso).getTime() - this.now();
		if (ms <= 0) {
			return 'window has reset';
		}
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
	}
}
