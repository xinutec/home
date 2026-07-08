import type { DeviceLatest, Measurement } from './measurement.model';
import { airSeries, climateSeries, rssiByReceiverSeries, toTrendPoints } from './series';

function reading(over: Partial<Measurement>): Measurement {
	return {
		ts: '2026-06-27T00:00:00.000Z',
		device: 'x',
		temp_c: null,
		humidity: null,
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
		...over,
	};
}

function dev(device: string, airQuality: boolean, order: number): DeviceLatest {
	return {
		...reading({ device }),
		label: { name: device, airQuality, order, type: 'test' },
		offset: {},
	};
}

describe('toTrendPoints', () => {
	it('drops null values and keeps valid points', () => {
		const rows = [
			reading({ ts: '2026-06-27T00:00:00.000Z', temp_c: 20 }),
			reading({ ts: '2026-06-27T01:00:00.000Z', temp_c: null }),
			reading({ ts: '2026-06-27T02:00:00.000Z', temp_c: 22 }),
		];
		const pts = toTrendPoints(rows, (m) => m.temp_c);
		expect(pts.map((p) => p.y)).toEqual([20, 22]);
	});

	it('drops points with an unparseable timestamp', () => {
		const rows = [reading({ ts: 'not-a-date', temp_c: 20 })];
		expect(toTrendPoints(rows, (m) => m.temp_c)).toEqual([]);
	});
});

describe('climateSeries', () => {
	it('builds one series per device, in order, with distinct colours', () => {
		const devices = [dev('airvisual', true, 0), dev('govee-A562', false, 1)];
		const history = {
			airvisual: [reading({ device: 'airvisual', temp_c: 25 })],
			'govee-A562': [reading({ device: 'govee-A562', temp_c: 24 })],
		};
		const s = climateSeries(devices, history, (m) => m.temp_c);
		expect(s.map((x) => x.label)).toEqual(['airvisual', 'govee-A562']);
		expect(s[0].points[0].y).toBe(25);
		expect(s[1].points[0].y).toBe(24);
		expect(s[0].color).not.toBe(s[1].color);
	});

	it('labels a sited device by its room, falling back to the id when unsited', () => {
		const sited = dev('govee-525D', false, 2);
		sited.label = { ...sited.label, room: 'Kitchen' };
		const s = climateSeries([sited, dev('govee-B7AC', false, 3)], {}, (m) => m.temp_c);
		expect(s.map((x) => x.label)).toEqual(['Kitchen', 'govee-B7AC']);
	});

	it('yields an empty points array for a device with no history', () => {
		const s = climateSeries([dev('govee-A562', false, 1)], {}, (m) => m.temp_c);
		expect(s[0].points).toEqual([]);
	});
});

describe('airSeries', () => {
	it('returns a single series from the air-quality device', () => {
		const devices = [dev('airvisual', true, 0), dev('govee-A562', false, 1)];
		const history = { airvisual: [reading({ device: 'airvisual', co2_ppm: 600 })] };
		const s = airSeries(devices, history, 'CO₂', 'red', (m) => m.co2_ppm);
		expect(s.length).toBe(1);
		expect(s[0].label).toBe('CO₂');
		expect(s[0].points[0].y).toBe(600);
	});

	it('returns nothing when there is no air-quality device', () => {
		const s = airSeries([dev('govee-A562', false, 1)], {}, 'CO₂', 'red', (m) => m.co2_ppm);
		expect(s).toEqual([]);
	});
});

describe('rssiByReceiverSeries', () => {
	it('splits a co-heard sensor into one line per receiver, suffixed by source', () => {
		const devices = [dev('govee-267F', false, 0)];
		const history = {
			'govee-267F': [
				reading({ ts: '2026-06-27T00:00:00.000Z', rssi: -69, source: 'bes' }),
				reading({ ts: '2026-06-27T00:05:00.000Z', rssi: -81, source: 'mac' }),
				reading({ ts: '2026-06-27T00:10:00.000Z', rssi: -68, source: 'bes' }),
			],
		};
		const s = rssiByReceiverSeries(devices, history);
		expect(s.map((x) => x.label)).toEqual(['govee-267F · bes', 'govee-267F · mac']);
		expect(s[0].points.map((p) => p.y)).toEqual([-69, -68]);
		expect(s[1].points.map((p) => p.y)).toEqual([-81]);
	});

	it('suffixes the receiver even when only one hears it', () => {
		const devices = [dev('govee-A562', false, 0)];
		const history = {
			'govee-A562': [reading({ rssi: -57, source: 'mac' })],
		};
		const s = rssiByReceiverSeries(devices, history);
		expect(s.length).toBe(1);
		expect(s[0].label).toBe('govee-A562 · mac');
	});

	it('labels pre-tag (null-source) rows as untagged', () => {
		const devices = [dev('govee-B7AC', false, 0)];
		const history = {
			'govee-B7AC': [reading({ rssi: -74, source: null })],
		};
		const s = rssiByReceiverSeries(devices, history);
		expect(s.map((x) => x.label)).toEqual(['govee-B7AC · untagged']);
	});

	it('drops devices with no rssi points (e.g. the wired IQAir)', () => {
		const devices = [dev('airvisual', true, 0)];
		const history = { airvisual: [reading({ device: 'airvisual', co2_ppm: 600, rssi: null })] };
		expect(rssiByReceiverSeries(devices, history)).toEqual([]);
	});
});
