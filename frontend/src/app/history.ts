import type { Measurement } from './measurement.model';

/**
 * Fold freshly-fetched rows into the ones already held: oldest first, one row
 * per instant, nothing older than the window.
 *
 * On a tie the fetched copy wins: it is the newer read of the row.
 */
export function mergeWindow(
	prev: readonly Measurement[],
	fetched: readonly Measurement[],
	windowStart: number,
): Measurement[] {
	const byTs = new Map<number, Measurement>();
	for (const row of [...prev, ...fetched]) {
		if (row.ts >= windowStart) {
			byTs.set(row.ts, row);
		}
	}
	return [...byTs.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** The instant of the newest row held, or null when none is. */
export function newestTs(rows: readonly Measurement[]): number | null {
	let newest: number | null = null;
	for (const row of rows) {
		if (newest === null || row.ts > newest) {
			newest = row.ts;
		}
	}
	return newest;
}
