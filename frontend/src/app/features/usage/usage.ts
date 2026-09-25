import { DecimalPipe } from '@angular/common';
import { Component, type OnDestroy, type OnInit, inject, signal } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../api.service';
import { RelativeTimePipe } from '../../relative-time.pipe';
import { FIVE_HOURS, UsageLevel, WEEK } from './level';

/** `/claude`: the account's Claude Code usage, one bar per rate-limit window. */
@Component({
	selector: 'app-usage',
	imports: [
		DecimalPipe,
		MatCardModule,
		MatIconModule,
		MatTooltipModule,
		RelativeTimePipe,
		UsageLevel,
	],
	templateUrl: './usage.html',
	styleUrl: './usage.scss',
})
export class UsagePage implements OnInit, OnDestroy {
	private readonly api = inject(ApiService);
	protected readonly usage = this.api.usage;

	protected readonly fiveHours = FIVE_HOURS;
	protected readonly week = WEEK;

	// Ticks so the "as of" stamp and the countdowns keep moving.
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
	 * A window's figure, or `null` once that window has reset: the figure then
	 * describes a window that no longer exists. Common, not a corner case — the
	 * reporting machine may have gone quiet hours ago. Judged per window, since
	 * the five hours can be over while the week is still running.
	 */
	protected live(pct: number | null, iso: string | null): number | null {
		if (pct == null || !iso) {
			return null;
		}
		return new Date(iso).getTime() > this.now() ? pct : null;
	}

	/** "resets in 2h 5m", or "window has reset" once it has; empty with no reset time. */
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
