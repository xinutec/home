import { type DeviceLatest, type Measurement, ROOM_COLORS } from './measurement.model';
import type { ChartSeries, TrendPoint } from './trend-chart/trend-chart';

/** Project history rows onto chart points, dropping null values and bad timestamps. */
export function toTrendPoints(
	rows: Measurement[],
	pick: (m: Measurement) => number | null,
): TrendPoint[] {
	const out: TrendPoint[] = [];
	for (const m of rows) {
		const y = pick(m);
		if (y == null) {
			continue;
		}
		const x = new Date(m.ts).getTime();
		if (!Number.isNaN(x)) {
			out.push({ x, y });
		}
	}
	return out;
}

/** One coloured line per device (in the given order) for a climate metric. */
export function climateSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
	pick: (m: Measurement) => number | null,
	offsetOf: (d: DeviceLatest) => number = () => 0,
): ChartSeries[] {
	return devices.map((d, i) => {
		const off = offsetOf(d);
		return {
			label: d.label.room ?? d.label.name,
			color: ROOM_COLORS[i % ROOM_COLORS.length],
			points: toTrendPoints(history[d.device] ?? [], pick).map((p) => ({ x: p.x, y: p.y + off })),
		};
	});
}

/**
 * RSSI split into one line per receiver (`source`). A sensor two boxes hear
 * (e.g. the Mac + the phone) otherwise draws as a single line zig-zagging between
 * the two links' strengths; grouping by source gives one calm line per link. Every
 * line is suffixed with its receiver (` · mac` / ` · pixel5`) so the legend is
 * unambiguous even when a sensor has only one line. Rows captured before source
 * tagging (null source; also the wired IQAir) group under ` · untagged` — a
 * transient bucket that ages out as the window scrolls past the tagging deploy.
 * Empty lines are dropped.
 */
export function rssiByReceiverSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
): ChartSeries[] {
	const out: ChartSeries[] = [];
	for (const d of devices) {
		// Group this device's rows by capturing receiver, preserving first-seen order.
		const bySource = new Map<string, Measurement[]>();
		for (const m of history[d.device] ?? []) {
			const key = m.source ?? 'untagged';
			let group = bySource.get(key);
			if (!group) {
				group = [];
				bySource.set(key, group);
			}
			group.push(m);
		}
		const name = d.label.room ?? d.label.name;
		for (const [source, rows] of bySource) {
			const points = toTrendPoints(rows, (m) => m.rssi);
			if (points.length === 0) {
				continue;
			}
			out.push({
				label: `${name} · ${source}`,
				color: ROOM_COLORS[out.length % ROOM_COLORS.length],
				points,
			});
		}
	}
	return out;
}

/** A single line from the air-quality device, or none if there isn't one. */
export function airSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
	label: string,
	color: string,
	pick: (m: Measurement) => number | null,
): ChartSeries[] {
	const air = devices.find((d) => d.label.airQuality);
	if (!air) {
		return [];
	}
	return [{ label, color, points: toTrendPoints(history[air.device] ?? [], pick) }];
}
