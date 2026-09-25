import { Component, computed, input } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long each window runs. Passed in, never inferred from the card's label. */
export const FIVE_HOURS = 5 * HOUR;
export const WEEK = 7 * DAY;

/**
 * One window's bar, marked to show pace: the clock mark is how far through the
 * window the reading was taken, so fill past it is spending faster than time
 * runs. Day ticks give a week bar a unit.
 */
@Component({
	selector: 'app-usage-level',
	imports: [MatProgressBarModule],
	templateUrl: './level.html',
	styleUrl: './level.scss',
})
export class UsageLevel {
	/** `null` once the window has turned over; then no marks are drawn either. */
	readonly pct = input<number | null>(null);

	/** When this window turns over. */
	readonly resetsAt = input<string | null>(null);

	/**
	 * When `pct` was read. The clock mark is placed at this instant, not the
	 * browser's now: against an hours-old figure, now would show a pace that
	 * worsens just because the page stays open.
	 */
	readonly takenAt = input<string | null>(null);

	readonly span = input.required<number>();

	/** The window's name, for the bar's accessible label. */
	readonly label = input('');

	/** Day boundaries, 0–100, ends excluded. None for windows under two days. */
	protected readonly days = computed<number[]>(() => {
		const span = this.span();
		if (this.pct() == null || span < 2 * DAY) {
			return [];
		}
		const count = Math.round(span / DAY);
		return Array.from({ length: count - 1 }, (_, i) => ((i + 1) / count) * 100);
	});

	/** How far through the window the clock stood at the reading, 0–100. */
	protected readonly clock = computed<number | null>(() => {
		const resets = this.resetsAt();
		const taken = this.takenAt();
		if (this.pct() == null || !resets || !taken) {
			return null;
		}
		const left = new Date(resets).getTime() - new Date(taken).getTime();
		if (!Number.isFinite(left)) {
			return null;
		}
		const span = this.span();
		// Clamped: a reading just after a turnover can carry a reset further out
		// than the window is long.
		return Math.min(100, Math.max(0, ((span - left) / span) * 100));
	});
}
