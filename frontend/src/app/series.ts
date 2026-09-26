import { type DeviceLatest, type Measurement, RECEIVER_COLORS } from './measurement.model';
import type { ChartSeries, TrendPoint } from './trend-chart/trend-chart';

/** Chart points, skipping nulls. */
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
		out.push({ x: m.ts, y });
	}
	return out;
}

/** One line per device, in the device's colour. */
export function climateSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
	pick: (m: Measurement) => number | null,
	offsetOf: (d: DeviceLatest) => number = () => 0,
): ChartSeries[] {
	return devices.map((d) => {
		const off = offsetOf(d);
		return {
			label: d.label.room ?? d.label.name,
			color: d.label.color,
			points: toTrendPoints(history[d.device] ?? [], pick).map((p) => ({ x: p.x, y: p.y + off })),
		};
	});
}

/**
 * RSSI, one line per (device, receiver): one line per device would zig-zag
 * between two receivers' readings of it. Labelled `Room · receiver`; rows with
 * no receiver are `untagged`.
 */
export function rssiByReceiverSeries(
	devices: DeviceLatest[],
	history: Record<string, Measurement[]>,
): ChartSeries[] {
	const out: ChartSeries[] = [];
	for (const d of devices) {
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
				color: RECEIVER_COLORS[out.length % RECEIVER_COLORS.length],
				points,
			});
		}
	}
	return out;
}

/** One line from the air-quality device, if there is one. */
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
