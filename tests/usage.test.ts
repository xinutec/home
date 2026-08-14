import { describe, expect, it } from "vitest";
import { freshestPerModel } from "../src/routes/api.js";
import { UsageInput } from "../src/usage.js";

/**
 * ⚠ **Absent and empty are different statements, and the write path turns on
 * exactly that.** Two pushers report this endpoint and only one of them can see
 * a model's own allowance: the CLI's statusLine payload carries `five_hour` and
 * `seven_day` and nothing else (read out of the binary, CLI 2.1.226), while the
 * console asks `get_usage` and receives the `model_scoped` array too.
 *
 * So a push with no `models` key means *this pusher cannot say* and must leave
 * the host's scoped rows alone, while `models: []` means *this account has no
 * scoped window* and clears them. Collapsing the two — the obvious reading of an
 * optional array — would delete the Fable figure every ten minutes, whenever
 * somebody happened to have a terminal open.
 */
describe("UsageInput.models", () => {
	it("keeps a push that says nothing about models distinct from one that says none", () => {
		const silent = UsageInput.parse({ host: "mac-mini", seven_day_pct: 87 });
		expect(silent.models).toBeUndefined();

		const none = UsageInput.parse({ host: "mac-mini", seven_day_pct: 87, models: [] });
		expect(none.models).toEqual([]);
	});

	it("takes a scoped window whole, name and reset included", () => {
		const parsed = UsageInput.parse({
			host: "mac-mini",
			seven_day_pct: 87,
			models: [{ model: "Fable", pct: 6, resets_at: "2026-08-14T01:59:59.000Z" }],
		});
		expect(parsed.models).toEqual([
			{ model: "Fable", pct: 6, resets_at: "2026-08-14T01:59:59.000Z" },
		]);
	});

	it("takes the model as data rather than checking it against a list", () => {
		// The fixed keys the CLI used to scope by — `seven_day_opus`,
		// `seven_day_sonnet` — both read null now, and the live scope is one this
		// schema had never heard of. A model name it does not recognise is the
		// normal case, not an error.
		const parsed = UsageInput.parse({
			host: "mac-mini",
			models: [
				{ model: "Something-Not-Shipped-Yet", pct: 0, resets_at: "2026-08-14T01:59:59.000Z" },
			],
		});
		expect(parsed.models?.[0]?.model).toBe("Something-Not-Shipped-Yet");
	});
});

/**
 * The read path's fold, and the reason it is not a one-liner. `new Map(rows.map(
 * …))` keeps the LAST value for a repeated key, so folding rows that arrive
 * newest-first kept the oldest reading of each model — a stale percentage that
 * looks exactly like a current one. Two hosts reporting the same scope is all it
 * takes, so the test feeds it exactly that.
 */
describe("freshestPerModel", () => {
	it("keeps the first row seen for a model, so newest-first input wins", () => {
		const rows = [
			{ model: "Fable", host: "mac-mini", pct: 6 },
			{ model: "Fable", host: "isis", pct: 99 },
			{ model: "Opus", host: "isis", pct: 40 },
		];
		expect(freshestPerModel(rows)).toEqual([
			{ model: "Fable", host: "mac-mini", pct: 6 },
			{ model: "Opus", host: "isis", pct: 40 },
		]);
	});

	it("has nothing to say about no rows", () => {
		expect(freshestPerModel([])).toEqual([]);
	});
});
