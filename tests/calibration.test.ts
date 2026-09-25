import { describe, expect, it } from "vitest";
import { offsetFor } from "../src/calibration.js";

describe("offsetFor", () => {
	// Shape, not values: the values change with every re-calibration.
	it("returns a finite temperature offset for each known device", () => {
		for (const device of ["airvisual", "govee-A562", "govee-525D", "govee-B7AC", "govee-267F"]) {
			expect(Number.isFinite(offsetFor(device).temp_c)).toBe(true);
		}
	});

	it("returns an empty object for an unmapped device", () => {
		expect(offsetFor("govee-FFFF")).toEqual({});
	});
});
