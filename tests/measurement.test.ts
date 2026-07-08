import { describe, expect, it } from "vitest";
import { MeasurementBatch, MeasurementInput } from "../src/measurement.js";

describe("MeasurementInput", () => {
	it("accepts a full AirVisual reading", () => {
		const r = MeasurementInput.safeParse({
			ts: "2026-06-23T14:30:00.000Z",
			device: "airvisual",
			temp_c: 25.8,
			humidity: 68,
			co2_ppm: 695,
			pm01: 2,
			pm25: 2,
			pm10: 2,
			aqi_us: 11,
			voc_ppb: null,
		});
		expect(r.success).toBe(true);
	});

	it("defaults device and allows missing sensors", () => {
		const r = MeasurementInput.parse({ temp_c: 20 });
		expect(r.device).toBe("airvisual");
		expect(r.humidity).toBeUndefined();
	});

	it("rejects out-of-range humidity", () => {
		expect(MeasurementInput.safeParse({ humidity: 250 }).success).toBe(false);
	});

	it("rejects a non-numeric temperature", () => {
		expect(MeasurementInput.safeParse({ temp_c: "hot" }).success).toBe(false);
	});

	it("rejects a malformed timestamp", () => {
		expect(MeasurementInput.safeParse({ ts: "yesterday" }).success).toBe(false);
	});

	it("accepts Govee device-health fields (battery, rssi)", () => {
		const r = MeasurementInput.parse({
			device: "govee-A562",
			temp_c: 25,
			humidity: 58,
			battery: 100,
			rssi: -62,
		});
		expect(r.battery).toBe(100);
		expect(r.rssi).toBe(-62);
	});

	it("rejects an out-of-range battery", () => {
		expect(MeasurementInput.safeParse({ battery: 150 }).success).toBe(false);
	});

	it("accepts smart-plug electrical fields", () => {
		const r = MeasurementInput.parse({
			device: "socket-coffee",
			power_w: 842.5,
			voltage_v: 238.2,
			current_a: 3.61,
			energy_kwh: 12.345,
			power_on: true,
		});
		expect(r.power_w).toBe(842.5);
		expect(r.voltage_v).toBe(238.2);
		expect(r.current_a).toBe(3.61);
		expect(r.energy_kwh).toBe(12.345);
		expect(r.power_on).toBe(true);
	});

	it("rejects negative power", () => {
		expect(MeasurementInput.safeParse({ power_w: -5 }).success).toBe(false);
	});

	it("nulls the BLE sentinel rssi (>= 0) but keeps real negative dBm", () => {
		expect(MeasurementInput.parse({ rssi: 127 }).rssi).toBeNull();
		expect(MeasurementInput.parse({ rssi: 0 }).rssi).toBeNull();
		expect(MeasurementInput.parse({ rssi: -62 }).rssi).toBe(-62);
	});
});

describe("MeasurementBatch", () => {
	it("accepts an array of readings", () => {
		const r = MeasurementBatch.safeParse({
			measurements: [{ temp_c: 20 }, { temp_c: 21, humidity: 50 }],
		});
		expect(r.success).toBe(true);
	});

	it("rejects an empty array", () => {
		expect(MeasurementBatch.safeParse({ measurements: [] }).success).toBe(false);
	});

	it("rejects more than 5000 readings", () => {
		const many = Array.from({ length: 5001 }, () => ({ temp_c: 20 }));
		expect(MeasurementBatch.safeParse({ measurements: many }).success).toBe(false);
	});

	it("rejects a bad reading inside the array", () => {
		expect(MeasurementBatch.safeParse({ measurements: [{ humidity: 250 }] }).success).toBe(false);
	});
});
