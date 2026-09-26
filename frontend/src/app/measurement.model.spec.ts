import { RANGE_KEYS, aqiBand, parseMeasurement, parseUsage, rangeMs } from './measurement.model';

describe('aqiBand', () => {
	it('classifies values into the correct US-AQI band', () => {
		expect(aqiBand(0)?.label).toBe('Good');
		expect(aqiBand(50)?.label).toBe('Good');
		expect(aqiBand(51)?.label).toBe('Moderate');
		expect(aqiBand(100)?.label).toBe('Moderate');
		expect(aqiBand(120)?.label).toBe('Unhealthy for Sensitive Groups');
		expect(aqiBand(175)?.label).toBe('Unhealthy');
		expect(aqiBand(250)?.label).toBe('Very Unhealthy');
		expect(aqiBand(400)?.label).toBe('Hazardous');
	});

	it('returns null for a missing value', () => {
		expect(aqiBand(null)).toBeNull();
		expect(aqiBand(undefined)).toBeNull();
	});
});

describe('history windows', () => {
	it('offers the windows shortest first', () => {
		expect([...RANGE_KEYS]).toEqual(['4h', '24h', '7d', '30d']);
	});

	it('converts each window to its span in ms', () => {
		expect(rangeMs('4h')).toBe(4 * 3_600_000);
		expect(rangeMs('30d')).toBe(30 * 24 * 3_600_000);
	});
});

describe('parsing a response', () => {
	const usage = {
		host: 'mac-mini',
		ts: '2026-08-04T17:10:00.000Z',
		five_hour_pct: 28,
		five_hour_resets_at: '2026-08-04T18:10:00.000Z',
		seven_day_pct: null,
		seven_day_resets_at: null,
		measured: false,
		models: [{ model: 'Fable', ts: '2026-08-04T17:10:00.000Z', pct: 6, resets_at: null }],
	};

	it('turns every instant into epoch ms and keeps null as null', () => {
		const u = parseUsage(usage);
		expect(u.ts).toBe(Date.parse('2026-08-04T17:10:00.000Z'));
		expect(u.five_hour_resets_at).toBe(Date.parse('2026-08-04T18:10:00.000Z'));
		expect(u.seven_day_resets_at).toBeNull();
		expect(u.models[0].resets_at).toBeNull();
	});

	it('refuses an instant that will not parse rather than drawing it somewhere', () => {
		expect(() => parseUsage({ ...usage, ts: 'yesterday' })).toThrow(/not an instant/);
		expect(() => parseMeasurement({ ...wireReading(), ts: 'not a date' })).toThrow(
			/not an instant/,
		);
	});
});

function wireReading() {
	return {
		device: 'govee-A562',
		ts: '2026-08-04T17:10:00.000Z',
		temp_c: 21,
		humidity: 50,
		co2_ppm: null,
		pm01: null,
		pm25: null,
		pm10: null,
		aqi_us: null,
		voc_ppb: null,
		battery: null,
		rssi: null,
		power_w: null,
		voltage_v: null,
		current_a: null,
		energy_kwh: null,
		power_on: null,
		source: null,
	};
}
