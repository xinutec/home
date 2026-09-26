import { Hono } from "hono";
import { z } from "zod";
import { offsetFor } from "../calibration.js";
import { db } from "../db/pool.js";
import type { ClaudeUsageTable, MeasurementTable } from "../db/tables.js";
import type { AppEnv } from "../env.js";
import { decorateDevices } from "../labels.js";
import { MeasurementBatch, MeasurementInput } from "../measurement.js";
import { TelemetryBatch, TelemetryEvent } from "../telemetry.js";
import { UsageInput } from "../usage.js";
import type { ClaudeUsage, DeviceLatest, Measurement, Receiver } from "../wire.js";

// How far back /api/receivers looks for the devices a receiver hears. Well past
// the slowest receiver's 10-minute push, so slow never reads as deaf.
const HEARD_WINDOW_MS = 60 * 60 * 1000;

// A malformed `from`/`to` must 400: an Invalid Date reaching the query filters
// nothing and returns the unfiltered range.
export const MeasurementsQuery = z.object({
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
	device: z.string().min(1).max(64).default("airvisual"),
	limit: z.coerce.number().int().positive().max(20000).default(5000),
});

function sensorValues(m: MeasurementInput): Omit<MeasurementTable, "device" | "ts"> {
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
		power_on: m.power_on == null ? null : m.power_on ? 1 : 0,
		source: m.source ?? null,
	};
}

function toRow(m: MeasurementInput): MeasurementTable {
	return { device: m.device, ts: m.ts ? new Date(m.ts) : new Date(), ...sensorValues(m) };
}

function toUsageRow(u: UsageInput): ClaudeUsageTable {
	return {
		host: u.host,
		ts: u.ts ? new Date(u.ts) : new Date(),
		five_hour_pct: u.five_hour_pct ?? null,
		five_hour_resets_at: u.five_hour_resets_at ? new Date(u.five_hour_resets_at) : null,
		seven_day_pct: u.seven_day_pct ?? null,
		seven_day_resets_at: u.seven_day_resets_at ? new Date(u.seven_day_resets_at) : null,
		measured: u.measured ? 1 : 0,
	};
}

/** Flatten client text to one log field. This is the telemetry endpoint's
 *  security boundary: a newline would let a client forge whole `client-event`
 *  lines under someone else's name, and zero-width or bidi characters would make
 *  a line display as something other than what it says. Capped by code point,
 *  so a glyph is never split. */
export function oneLine(raw: string, max: number): string {
	const unbroken = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
	return [...unbroken.replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** One row per model, the first seen — so pass them freshest first. Not
 *  `new Map(rows.map(…))`: that keeps the last, i.e. the oldest. */
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

	// INSERT IGNORE: an existing (device, ts) is kept, so a re-sent batch is harmless.
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

	// A host's latest Claude Code usage, from the statusLine hook or the console.
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
				measured: row.measured,
			})
			.execute();
		// Absent `models` leaves the scoped rows alone; `[]` clears them. See
		// `UsageInput.models`.
		const models = parsed.data.models;
		if (models) {
			// One transaction: a `GET /api/usage` between the delete and the
			// inserts would find the cards gone.
			await db()
				.transaction()
				.execute(async (trx) => {
					// Drop the scopes the push no longer names; the upsert only adds.
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

	// The freshest row across hosts: the figures are account-wide.
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
		// Across all hosts, not just the one above: its pusher may not see scopes.
		const scoped = await db()
			.selectFrom("claude_usage_model")
			.selectAll()
			.orderBy("ts", "desc")
			.execute();
		const usage: ClaudeUsage<Date> = {
			...row,
			measured: row.measured === 1,
			models: freshestPerModel(scoped),
		};
		return c.json(usage);
	});

	// The latest reading per device, labelled and in UI order.
	api.get("/devices", async (c) => {
		// Each device's newest ts joined back to its row; (device, ts) is the
		// primary key, so that is one row each, read off the index.
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
		const out: DeviceLatest<Date>[] = decorateDevices(rows).map((d) => ({
			...d,
			offset: offsetFor(d.device),
		}));
		return c.json(out);
	});

	// Per receiver: when it last pushed and which devices it hears. A sensor stays
	// fresh while ANY receiver hears it, so only this view shows one receiver dying.
	api.get("/receivers", async (c) => {
		const rows = await db()
			.selectFrom("measurement")
			.select(({ fn }) => ["source", fn.max("ts").as("last_seen")])
			.where("source", "is not", null)
			.groupBy("source")
			.execute();

		// A receiver deaf to one sensor still has a fresh `last_seen`; its list
		// shrinks instead.
		const since = new Date(Date.now() - HEARD_WINDOW_MS);
		const heard = await db()
			.selectFrom("measurement")
			.select(["source", "device"])
			.distinct()
			.where("source", "is not", null)
			.where("ts", ">=", since)
			.execute();

		const out: Receiver<Date>[] = rows.map((r) => ({
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

	// One device's readings in a range, oldest first.
	api.get("/measurements", async (c) => {
		const parsed = MeasurementsQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: "invalid query", detail: parsed.error.flatten() }, 400);
		}
		const { from, to, device, limit } = parsed.data;
		// Newest first, then reversed: `limit` must cut the old end. Cutting the
		// new end stops every chart part-way, which reads as the sensors dying.
		let q = db()
			.selectFrom("measurement")
			.selectAll()
			.where("device", "=", device)
			.orderBy("ts", "desc");
		if (from) q = q.where("ts", ">=", from);
		if (to) q = q.where("ts", "<=", to);
		const rows: Measurement<Date>[] = await q.limit(limit).execute();
		rows.reverse();
		return c.json(rows);
	});

	// The browser's activity trace (taps, navigations), written to the pod log
	// as the fleet's `client-event` lines; nothing is stored. Session-gated: an
	// ungated write on a public host is an open log-write, and a public page
	// cannot hold the ingest token.
	api.post("/telemetry", async (c) => {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "not authenticated" }, 401);
		}

		const MAX_LABEL = 160;

		const batch = TelemetryBatch.safeParse(await c.req.json().catch(() => null));
		if (!batch.success) {
			return c.json({ error: "invalid payload", detail: batch.error.flatten() }, 400);
		}
		for (const raw of batch.data) {
			const e = TelemetryEvent.safeParse(raw);
			if (!e.success) continue;
			const kind = oneLine(e.data.kind, 32);
			const path = oneLine(e.data.path, MAX_LABEL);
			const label = oneLine(e.data.label ?? "", MAX_LABEL);
			console.log(
				`client-event user=${session.userId} kind=${kind} path=${path} label=${label} at=${e.data.at}`,
			);
		}
		// Best-effort: the client neither reads this nor retries.
		return c.body(null, 204);
	});

	return api;
}
