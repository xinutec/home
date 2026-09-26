import { mergeWindow, newestTs } from './history';
import type { Measurement } from './measurement.model';

function row(iso: string, temp: number): Measurement {
	return { device: 'govee-A562', ts: Date.parse(iso), temp_c: temp } as Measurement;
}

describe('mergeWindow', () => {
	const start = Date.parse('2026-08-14T00:00:00Z');

	it('appends what the delta brought, oldest first', () => {
		const merged = mergeWindow(
			[row('2026-08-14T01:00:00Z', 21)],
			[row('2026-08-14T02:00:00Z', 22), row('2026-08-14T03:00:00Z', 23)],
			start,
		);
		expect(merged.map((m) => m.temp_c)).toEqual([21, 22, 23]);
	});

	it('places a late row by its instant, not by when it arrived', () => {
		const merged = mergeWindow(
			[row('2026-08-14T01:00:00Z', 21), row('2026-08-14T03:00:00Z', 23)],
			[row('2026-08-14T02:00:00Z', 22)],
			start,
		);
		expect(merged.map((m) => m.temp_c)).toEqual([21, 22, 23]);
	});

	it('keeps the fetched copy of a row already held', () => {
		const merged = mergeWindow(
			[row('2026-08-14T01:00:00Z', 21)],
			[row('2026-08-14T01:00:00Z', 99)],
			start,
		);
		expect(merged.map((m) => m.temp_c)).toEqual([99]);
	});

	it('drops what the window has moved past', () => {
		const merged = mergeWindow(
			[row('2026-08-13T23:00:00Z', 20), row('2026-08-14T01:00:00Z', 21)],
			[],
			start,
		);
		expect(merged.map((m) => m.temp_c)).toEqual([21]);
	});
});

describe('newestTs', () => {
	it('is null when nothing is held', () => {
		expect(newestTs([])).toBeNull();
	});
});
