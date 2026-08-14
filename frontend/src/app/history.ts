import type { Measurement } from './measurement.model';

/**
 * Fold freshly-fetched rows into the ones already held: oldest first, one row
 * per instant, nothing older than the window.
 *
 * The fetched copy wins a tie, because it is the newer read of the same row —
 * a reading the server has since corrected must not be pinned by a cached one.
 * A row whose `ts` will not parse is dropped rather than sorted to the front,
 * where `NaN` would put it.
 */
export function mergeWindow(
	prev: readonly Measurement[],
	fetched: readonly Measurement[],
	windowStart: number,
): Measurement[] {
	const byTs = new Map<number, Measurement>();
	for (const row of [...prev, ...fetched]) {
		const at = Date.parse(row.ts);
		if (at >= windowStart) {
			byTs.set(at, row);
		}
	}
	return [...byTs.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** The instant of the newest row held, or null when none is. */
export function newestTs(rows: readonly Measurement[]): number | null {
	let newest: number | null = null;
	for (const row of rows) {
		const at = Date.parse(row.ts);
		if (!Number.isNaN(at) && (newest === null || at > newest)) {
			newest = at;
		}
	}
	return newest;
}
