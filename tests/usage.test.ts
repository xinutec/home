import { describe, expect, it } from "vitest";
import { freshestPerModel } from "../src/routes/api.js";
import { UsageInput } from "../src/usage.js";

// Absent `models` leaves the stored scopes alone; `[]` clears them.
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
		const parsed = UsageInput.parse({
			host: "mac-mini",
			models: [
				{ model: "Something-Not-Shipped-Yet", pct: 0, resets_at: "2026-08-14T01:59:59.000Z" },
			],
		});
		expect(parsed.models?.[0]?.model).toBe("Something-Not-Shipped-Yet");
	});
});

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

describe("UsageInput.measured", () => {
	it("a writer that does not say claims the weaker kind", () => {
		const silent = UsageInput.parse({ host: "mac-mini", seven_day_pct: 87 });
		expect(silent.measured).toBeUndefined();
	});

	it("a live probe may say so", () => {
		const live = UsageInput.parse({ host: "mac-mini", seven_day_pct: 11, measured: true });
		expect(live.measured).toBe(true);
	});
});
