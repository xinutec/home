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
	 * Human "resets in Xh Ym" for a rate-limit window's reset instant. Reads the
	 * `now()` tick so the countdown updates as time passes; empty when there's no
	 * reset time (window absent from the snapshot).
	 */
	protected fmtReset(iso: string | null): string {
		if (!iso) {
			return '';
		}
		const ms = new Date(iso).getTime() - this.now();
		if (ms <= 0) {
			return 'resets now';
		}
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
	}
}
