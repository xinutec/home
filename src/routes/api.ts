import { Hono } from "hono";
import { z } from "zod";
import { offsetFor } from "../calibration.js";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
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

/** Flatten a client-supplied label to a single harmless log field.
 *
 *  The security boundary of the telemetry endpoint, not tidiness. A label is
 *  verbatim UI text written into a log line as `label=…`, so a newline inside it
 *  forges *whole log lines* — including further `client-event` lines attributed
 *  to someone else. The log stops being the evidence it exists to be.
 *
 *  Also flattens the format characters that deceive rather than break: the
 *  zero-width ones (a label of them reads as empty while occupying the cap) and
 *  the bidi overrides (they reorder the *rendering* of a line, so it displays as
 *  something other than what it says). Capped by code point so a multi-byte
 *  glyph is never split down the middle. */
export function oneLine(raw: string, max: number): string {
	const unbroken = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
	return [...unbroken.replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** One row per model, keeping the first seen — so pass them freshest first.
 *
 *  ⚠ Written as a first-wins loop rather than `new Map(rows.map(…))`, which was
 *  the bug: a Map takes the LAST value for a repeated key, so folding rows that
 *  arrive newest-first kept the OLDEST reading of each model. Two hosts
 *  reporting the same scope is all it takes, and a stale percentage looks
 *  exactly like a current one. */
export function freshestPerModel<T extends { model: string }>(rows: readonly T[]): T[] {
	const byModel = new Map<string, T>();
	for (const row of rows) {
		if (!byModel.has(row.model)) {
			byModel.set(row.model, row);
		}
	}
	return [...byModel.values()];
}

export function apiRoutes(ingestToken: string): Hono<AppEnv> {
	const api = new Hono<AppEnv>();

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
		// ⚠ **Only when the payload speaks to them.** A pusher that cannot see
		// model scopes omits the key entirely, and its push must leave this host's
		// scoped rows exactly as they were — see `UsageInput.models`. An empty
		// array is a statement and does clear them.
		const models = parsed.data.models;
		if (models) {
			// In one transaction, because the delete below and the writes after it
			// are one statement about this host: between them the account looks
			// like it has fewer scoped windows than it does, and `GET /api/usage`
			// is public and polled — it would read that gap and blank a card.
			await db()
				.transaction()
				.execute(async (trx) => {
					// A scope the account no longer has must go, and an upsert can only
					// ever add — so this host's rows for models NOT in the push are
					// dropped first. With an empty push that is all of them.
					let drop = trx.deleteFrom("claude_usage_model").where("host", "=", row.host);
					if (models.length > 0) {
						drop = drop.where(
							"model",
							"not in",
							models.map((m) => m.model),
						);
					}
					await drop.execute();
					for (const m of models) {
						const scoped = {
							host: row.host,
							model: m.model,
							ts: row.ts,
							pct: m.pct,
							resets_at: new Date(m.resets_at),
						};
						await trx
							.insertInto("claude_usage_model")
							.values(scoped)
							.onDuplicateKeyUpdate({
								ts: scoped.ts,
								pct: scoped.pct,
								resets_at: scoped.resets_at,
							})
							.execute();
					}
				});
		}
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
		if (!row) {
			return c.json(null);
		}
		// The model-scoped windows, freshest first. Account-wide like the rest, so
		// they are gathered across hosts rather than from the host whose snapshot
		// won above — that host may be one whose pusher cannot see scopes at all.
		const scoped = await db()
			.selectFrom("claude_usage_model")
			.selectAll()
			.orderBy("ts", "desc")
			.execute();
		return c.json({ ...row, models: freshestPerModel(scoped) });
	});

	// Public read: the latest reading per device, each tagged with its display
	// label and ordered for the UI. Drives the per-room tiles.
	api.get("/devices", async (c) => {
		// One query, not one per device: joining each device's newest instant back
		// to its row. `(device, ts)` is the primary key, so the join matches
		// exactly one row per device and the group-by reads the index.
		const rows = await db()
			.selectFrom("measurement as m")
			.innerJoin(
				(eb) =>
					eb
						.selectFrom("measurement")
						.select(({ fn }) => ["device", fn.max("ts").as("ts")])
						.groupBy("device")
						.as("newest"),
				(join) => join.onRef("newest.device", "=", "m.device").onRef("newest.ts", "=", "m.ts"),
			)
			.selectAll("m")
			.execute();
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
	// other receivers still covered all four sensors, so every device — and the whole
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
		// ⚠ Selected NEWEST first and reversed, though the response is oldest
		// first. The order decides which end `limit` throws away, and asking for
		// them oldest-first threw away the recent ones: past the cap a chart
		// stopped part-way, which reads as every sensor dying at once rather than
		// as a truncated answer. Measured 2026-08-14: 13,767 rows over 30 days on
		// the busiest device against the client's 20,000 — one more receiver
		// crosses it.
		let q = db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "desc");
		if (from) q = q.where("ts", ">=", from);
		if (to) q = q.where("ts", "<=", to);
		const rows = await q.limit(limit).execute();
		rows.reverse();
		return c.json(rows);
	});

	// Client activity trace: what the browser sees and the API does not. A tap
	// that hits a cache, a control that was disabled, a chart that rendered
	// wrong — none of it reaches the server otherwise, so "I looked and it was
	// blank" is undiagnosable.
	//
	// **Session-gated, unlike every read on this host.** home is publicly
	// readable, and an ungated write here would be an open log-write on the
	// internet: a flood nobody could attribute, on a node whose disk is shared
	// with every other app, and a channel that stops being evidence the moment a
	// stranger can forge entries in it. The Bearer token that guards /ingest is
	// no help — a public page cannot hold a secret.
	//
	// Same `client-event` line shape as the rest of the fleet, deliberately: the
	// value is grepping one word anywhere and getting the same fields. No
	// storage — these are logs, not data.
	api.post("/telemetry", async (c) => {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "not authenticated" }, 401);
		}

		// A per-batch cap so a buggy client cannot turn one POST into a log
		// flood, and a label cap so a pathological one cannot bloat a line.
		const MAX_EVENTS = 100;
		const MAX_LABEL = 160;

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body)) {
			return c.json({ error: "expected array" }, 400);
		}
		for (const raw of body.slice(0, MAX_EVENTS)) {
			if (!raw || typeof raw !== "object") continue;
			const e = raw as { kind?: unknown; path?: unknown; label?: unknown; at?: unknown };
			const kind = oneLine(String(e.kind ?? ""), 32);
			const path = oneLine(String(e.path ?? ""), MAX_LABEL);
			const label = oneLine(String(e.label ?? ""), MAX_LABEL);
			const at = Number(e.at ?? 0);
			console.log(
				`client-event user=${session.userId} kind=${kind} path=${path} label=${label} at=${at}`,
			);
		}
		// Always 204: telemetry is best-effort and the client neither reads the
		// response nor retries.
		return c.body(null, 204);
	});

	return api;
}
