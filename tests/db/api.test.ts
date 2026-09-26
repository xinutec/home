import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { apiRoutes } from "../../src/routes/api.js";
import { destroyPool, freshDatabase } from "./fresh.js";

const TOKEN = "test-token-0123456789";
const api = apiRoutes(TOKEN);

async function send(path: string, body: unknown): Promise<void> {
	const res = await api.request(path, {
		method: "POST",
		headers: { Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify(body),
	});
	expect(res.status, await res.clone().text()).toBe(200);
}

async function read<T>(path: string): Promise<T> {
	const res = await api.request(path);
	expect(res.status).toBe(200);
	return (await res.json()) as T;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(freshDatabase);
afterAll(destroyPool);

describe("readings", () => {
	it("serve each device's newest reading, labelled, offset and in UI order", async () => {
		await send("/ingest", { device: "govee-A562", ts: minutesAgo(10), temp_c: 20 });
		await send("/ingest", { device: "govee-A562", ts: minutesAgo(5), temp_c: 21 });
		await send("/ingest", { device: "airvisual", ts: minutesAgo(5), temp_c: 22, co2_ppm: 600 });
		const devices =
			await read<
				Array<{ device: string; temp_c: number; label: { room: string }; offset: unknown }>
			>("/devices");
		expect(devices.map((d) => [d.device, d.temp_c, d.label.room])).toEqual([
			["airvisual", 22, "Bedroom"],
			["govee-A562", 21, "Living Room"],
		]);
		expect(devices[0]?.offset).toHaveProperty("temp_c");
	});

	it("let a single reading replace one at the same instant, but not a batch", async () => {
		const ts = minutesAgo(5);
		await send("/ingest", { device: "govee-A562", ts, temp_c: 20 });
		await send("/ingest", { device: "govee-A562", ts, temp_c: 21 });
		await send("/ingest/batch", { measurements: [{ device: "govee-A562", ts, temp_c: 99 }] });
		const rows = await read<Array<{ temp_c: number }>>("/measurements?device=govee-A562");
		expect(rows.map((r) => r.temp_c)).toEqual([21]);
	});

	it("cut the oldest readings when over the limit, and answer oldest first", async () => {
		await send("/ingest/batch", {
			measurements: [30, 20, 10].map((m) => ({
				device: "govee-A562",
				ts: minutesAgo(m),
				temp_c: m,
			})),
		});
		const rows = await read<Array<{ temp_c: number }>>("/measurements?device=govee-A562&limit=2");
		expect(rows.map((r) => r.temp_c)).toEqual([20, 10]);
	});

	it("store the relay state and the BLE receiver as sent", async () => {
		await send("/ingest", {
			device: "socket-tv",
			ts: minutesAgo(1),
			power_w: 42.5,
			power_on: true,
		});
		await send("/ingest", { device: "govee-A562", ts: minutesAgo(1), rssi: -70, source: "mac" });
		const [plug] = await read<Array<{ power_w: number; power_on: number }>>(
			"/measurements?device=socket-tv",
		);
		expect([plug?.power_w, plug?.power_on]).toEqual([42.5, 1]);
		const [ble] = await read<Array<{ rssi: number; source: string }>>(
			"/measurements?device=govee-A562",
		);
		expect([ble?.rssi, ble?.source]).toEqual([-70, "mac"]);
	});

	it("list per receiver when it last pushed and which devices it hears now", async () => {
		await send("/ingest", { device: "govee-A562", ts: minutesAgo(5), source: "mac", temp_c: 20 });
		await send("/ingest", { device: "govee-525D", ts: minutesAgo(4), source: "mac", temp_c: 20 });
		await send("/ingest", {
			device: "govee-525D",
			ts: minutesAgo(3 * 60),
			source: "pixel5",
			temp_c: 20,
		});
		const receivers = await read<Array<{ source: string; devices: string[] }>>("/receivers");
		expect(receivers.map((r) => [r.source, r.devices])).toEqual([
			["mac", ["govee-525D", "govee-A562"]],
			["pixel5", []],
		]);
	});
});

describe("Claude usage", () => {
	const week = () => new Date(Date.now() + 86_400_000).toISOString();

	it("serves the freshest host's figures, with its measured flag as a boolean", async () => {
		await send("/usage", { host: "isis", ts: minutesAgo(30), seven_day_pct: 40 });
		await send("/usage", {
			host: "mac-mini",
			ts: minutesAgo(5),
			seven_day_pct: 41,
			measured: true,
		});
		const usage = await read<{ host: string; seven_day_pct: number; measured: boolean }>("/usage");
		expect([usage.host, usage.seven_day_pct, usage.measured]).toEqual(["mac-mini", 41, true]);
	});

	it("keeps a host's model scopes through a push that cannot see them, and clears them on []", async () => {
		const models = () => read<{ models: Array<{ model: string; pct: number }> }>("/usage");
		await send("/usage", {
			host: "mac-mini",
			seven_day_pct: 40,
			models: [{ model: "Fable", pct: 6, resets_at: week() }],
		});
		await send("/usage", { host: "mac-mini", seven_day_pct: 41 });
		expect((await models()).models.map((m) => [m.model, m.pct])).toEqual([["Fable", 6]]);
		await send("/usage", { host: "mac-mini", seven_day_pct: 42, models: [] });
		expect((await models()).models).toEqual([]);
	});

	it("drops a scope the push no longer names", async () => {
		await send("/usage", {
			host: "mac-mini",
			models: [
				{ model: "Fable", pct: 6, resets_at: week() },
				{ model: "Opus", pct: 9, resets_at: week() },
			],
		});
		await send("/usage", {
			host: "mac-mini",
			models: [{ model: "Fable", pct: 7, resets_at: week() }],
		});
		const usage = await read<{ models: Array<{ model: string; pct: number }> }>("/usage");
		expect(usage.models.map((m) => [m.model, m.pct])).toEqual([["Fable", 7]]);
	});

	it("is null before anything has reported", async () => {
		expect(await read<unknown>("/usage")).toBeNull();
	});
});
