import { Hono } from "hono";
import { z } from "zod";
import { offsetFor } from "../calibration.js";
import { db } from "../db/pool.js";
import { decorateDevices } from "../labels.js";
import { MeasurementBatch, MeasurementInput } from "../measurement.js";
import { UsageInput } from "../usage.js";

// How far back /api/receivers looks when listing the devices a receiver still
// hears. Comfortably wider than the slowest receiver's 10-minute push cadence, so
// a healthy-but-slow receiver never looks like it has gone deaf to a sensor.
const HEARD_WINDOW_MS = 60 * 60 * 1000;

// Query parameters for /api/measurements. Validated like the write path — a
// malformed `from`/`to` must 400, not silently return an unfiltered range
// (`new Date("garbage")` is an Invalid Date the driver won't filter on).
export const MeasurementsQuery = z.object({
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
	device: z.string().min(1).max(64).default("airvisual"),
	limit: z.coerce.number().int().positive().max(20000).default(5000),
});

function sensorValues(m: MeasurementInput) {
	return {
		temp_c: m.temp_c ?? null,
		humidity: m.humidity ?? null,
		co2_ppm: m.co2_ppm ?? null,
		pm01: m.pm01 ?? null,
		pm25: m.pm25 ?? null,
		pm10: m.pm10 ?? null,
		aqi_us: m.aqi_us ?? null,
		voc_ppb: m.voc_ppb ?? null,
		battery: m.battery ?? null,
		rssi: m.rssi ?? null,
		power_w: m.power_w ?? null,
		voltage_v: m.voltage_v ?? null,
		current_a: m.current_a ?? null,
		energy_kwh: m.energy_kwh ?? null,
		// Boolean relay state stored as 0/1; MariaDB TINYINT round-trips as a number.
		power_on: m.power_on == null ? null : m.power_on ? 1 : 0,
		source: m.source ?? null,
	};
}

function toRow(m: MeasurementInput) {
	return { device: m.device, ts: m.ts ? new Date(m.ts) : new Date(), ...sensorValues(m) };
}

function toUsageRow(u: UsageInput) {
	return {
		host: u.host,
		ts: u.ts ? new Date(u.ts) : new Date(),
		five_hour_pct: u.five_hour_pct ?? null,
		five_hour_resets_at: u.five_hour_resets_at ? new Date(u.five_hour_resets_at) : null,
		seven_day_pct: u.seven_day_pct ?? null,
		seven_day_resets_at: u.seven_day_resets_at ? new Date(u.seven_day_resets_at) : null,
	};
}

export function apiRoutes(ingestToken: string): Hono {
	const api = new Hono();

	const authed = (auth: string | undefined) => auth === `Bearer ${ingestToken}`;

	// Token-gated write: the Mac poller POSTs one reading here.
	api.post("/ingest", async (c) => {
		if (!authed(c.req.header("Authorization"))) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const parsed = MeasurementInput.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const m = parsed.data;
		await db()
			.insertInto("measurement")
			.values(toRow(m))
			.onDuplicateKeyUpdate(sensorValues(m))
			.execute();
		return c.json({ ok: true });
	});

	// Token-gated bulk write: the backfill importer POSTs arrays of readings.
	// INSERT IGNORE — historical rows are immutable, so an existing (device, ts)
	// key is skipped, making re-runs idempotent.
	api.post("/ingest/batch", async (c) => {
		if (!authed(c.req.header("Authorization"))) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const parsed = MeasurementBatch.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const rows = parsed.data.measurements.map(toRow);
		await db().insertInto("measurement").ignore().values(rows).execute();
		return c.json({ ok: true, received: rows.length });
	});

	// Token-gated write: a machine's Claude Code statusLine hook POSTs its latest
	// usage snapshot here. Upsert on host — this is current state, not history, so
	// a re-push just overwrites the host's row.
	api.post("/usage", async (c) => {
		if (!authed(c.req.header("Authorization"))) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const parsed = UsageInput.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return c.json({ error: "invalid payload", detail: parsed.error.flatten() }, 400);
		}
		const row = toUsageRow(parsed.data);
		await db()
			.insertInto("claude_usage")
			.values(row)
			.onDuplicateKeyUpdate({
				ts: row.ts,
				five_hour_pct: row.five_hour_pct,
				five_hour_resets_at: row.five_hour_resets_at,
				seven_day_pct: row.seven_day_pct,
				seven_day_resets_at: row.seven_day_resets_at,
			})
			.execute();
		return c.json({ ok: true });
	});

	// Public read: the freshest usage snapshot. The figures are account-wide, so
	// the most recently captured row (across all hosts) is the current truth; the
	// host + ts it carries let the UI show which machine reported it and how long
	// ago — a stale snapshot just means no active session has pushed lately.
	api.get("/usage", async (c) => {
		const row = await db()
			.selectFrom("claude_usage")
			.selectAll()
			.orderBy("ts", "desc")
			.limit(1)
			.executeTakeFirst();
		return c.json(row ?? null);
	});

	// Public read: the latest reading per device, each tagged with its display
	// label and ordered for the UI. Drives the per-room tiles.
	api.get("/devices", async (c) => {
		const devices = await db().selectFrom("measurement").select("device").distinct().execute();
		const latest = await Promise.all(
			devices.map((d) =>
				db()
					.selectFrom("measurement")
					.selectAll()
					.where("device", "=", d.device)
					.orderBy("ts", "desc")
					.limit(1)
					.executeTakeFirst(),
			),
		);
		const rows = latest.filter((r): r is NonNullable<typeof r> => r != null);
		// Serve raw + each device's calibration offset; the client applies it so
		// the correction can be toggled.
		const out = decorateDevices(rows).map((d) => ({ ...d, offset: offsetFor(d.device) }));
		return c.json(out);
	});

	// Public read: per-RECEIVER liveness — when each capturing host (`source`) last
	// pushed, and which devices it currently hears.
	//
	// Keyed by source, not device, and that distinction is the whole point: a sensor
	// stays fresh as long as ANY receiver hears it, so device freshness cannot see a
	// single receiver going deaf. When the pixel5 receiver went silent for 7 hours the
	// Mac and bes still covered all four sensors, so every device — and the whole
	// dashboard — stayed green. This is the view that makes a dead receiver visible.
	api.get("/receivers", async (c) => {
		const rows = await db()
			.selectFrom("measurement")
			.select(({ fn }) => ["source", fn.max("ts").as("last_seen")])
			.where("source", "is not", null)
			.groupBy("source")
			.execute();

		// Devices each receiver has heard recently. A receiver that is up but has gone
		// deaf to one sensor (a real, separate failure) shows a shrunken list here
		// rather than a stale `last_seen`, since the sensors it still hears keep it
		// looking alive.
		const since = new Date(Date.now() - HEARD_WINDOW_MS);
		const heard = await db()
			.selectFrom("measurement")
			.select(["source", "device"])
			.distinct()
			.where("source", "is not", null)
			.where("ts", ">=", since)
			.execute();

		const out = rows.map((r) => ({
			source: r.source,
			last_seen: r.last_seen,
			devices: heard
				.filter((h) => h.source === r.source)
				.map((h) => h.device)
				.sort(),
		}));
		out.sort((a, b) => (a.source ?? "").localeCompare(b.source ?? ""));
		return c.json(out);
	});

	// Public read: a time range, oldest first, for charting.
	api.get("/measurements", async (c) => {
		const parsed = MeasurementsQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: "invalid query", detail: parsed.error.flatten() }, 400);
		}
		const { from, to, device, limit } = parsed.data;
		let q = db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "asc");
		if (from) q = q.where("ts", ">=", from);
		if (to) q = q.where("ts", "<=", to);
		const rows = await q.limit(limit).execute();
		return c.json(rows);
	});

	return api;
}
