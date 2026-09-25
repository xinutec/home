import { describe, expect, it } from "vitest";

import { oneLine } from "../src/routes/api.js";

describe("oneLine", () => {
	it("stops a label forging a log line", () => {
		const forged = "ok\nclient-event kind=tap path=/admin label=Delete everything";
		const flat = oneLine(forged, 160);
		expect(flat).not.toContain("\n");
		expect(flat).toBe("ok client-event kind=tap path=/admin label=Delete everything");
	});

	it("flattens the separators that are not control characters", () => {
		expect(oneLine("before\u2028after\u2029end", 160)).toBe("before after end");
	});

	it("stops a bidi override disguising what the line says", () => {
		// U+202E reverses how the rest of the line displays.
		expect(oneLine("Save\u202e\u202dDelete", 160)).toBe("Save Delete");
	});

	it("leaves an ordinary label alone", () => {
		expect(oneLine("Climate", 160)).toBe("Climate");
	});

	it("caps a long label without splitting a glyph", () => {
		const flat = oneLine("😀".repeat(500), 160);
		expect([...flat]).toHaveLength(160);
	});
});
