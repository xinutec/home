import { Component, computed, input } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How long each window runs.
 *
 * ⚠ **Carried as data, not read off the label.** Keying on the card's heading
 * would make a display string load-bearing, so renaming a row would silently
 * drop its marks. Same rule as the console's copy — `usage-strip.ts` in memview.
 */
export const FIVE_HOURS = 5 * HOUR;
export const WEEK = 7 * DAY;

/**
 * One window's bar, with the two marks that turn a percentage into a pace.
 *
 * A figure on its own says how much is gone, never whether that is a lot for
 * how far in we are. The **clock mark** is where the window's own clock stood
 * when the figure was read, so the gap between fill and mark is the whole
 * message: fill behind it is room to spare, fill past it is spending faster
 * than the week runs. The **day ticks** give that comparison a unit — a week
 * bar with no marks is seven days of undifferentiated length.
 *
 * The bar and its marks share one box on purpose: they are positions ON the
 * level, not siblings beside it.
 */
@Component({
	selector: 'app-usage-level',
	imports: [MatProgressBarModule],
	templateUrl: './level.html',
	styleUrl: './level.scss',
})
export class UsageLevel {
	/**
	 * The figure to draw, already judged live by the page — `null` when the
	 * window it belonged to has turned over.
	 *
	 * ⚠ **No figure means no marks either.** A clock mark over a bar with no
	 * reading behind it invites the comparison the missing figure exists to
	 * prevent.
	 */
	readonly pct = input<number | null>(null);

	/** When this window turns over. */
	readonly resetsAt = input<string | null>(null);

	/**
	 * When the figure was captured — the instant `pct` belongs to.
	 *
	 * ⚠ **The clock mark is read at the SAME instant as `pct`, and that is the
	 * whole point.** Placing it from the browser's own clock would compare a
	 * fresh time against a spend that can be hours old, which is exactly the
	 * false reading `live()` was written to stop: a stale bar would appear to
	 * fall further and further behind pace as the page sat open, purely from
	 * time passing. Both halves come from one reading, so their distance apart
	 * is a fact rather than an artefact of when somebody looked.
	 */
	readonly takenAt = input<string | null>(null);

	/** How long the window runs — `FIVE_HOURS` or `WEEK`. */
	readonly span = input.required<number>();

	/** The window's name, for the bar's accessible label. */
	readonly label = input('');

	/**
	 * Where the day boundaries fall, 0–100. Ends excluded: the bar's own edges
	 * already mark those.
	 *
	 * Empty under two days, which is what drops them from the five-hour window —
	 * ticks are for judging pace across a week, and five hours has no unit a
	 * person tracks.
	 */
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
		// ⚠ **Clamped, because a reading can outlive its own window.** A machine
		// that reported just after a turnover carries a `resets_at` further out
		// than the window is long, which would place the mark off the bar — and a
		// mark off the bar is worse than none.
		return Math.min(100, Math.max(0, ((span - left) / span) * 100));
	});
}
