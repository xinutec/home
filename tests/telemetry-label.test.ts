import { describe, expect, it } from "vitest";

import { oneLine } from "../src/routes/api.js";

describe("oneLine", () => {
	it("stops a label forging a log line", () => {
		// The attack this exists for: the label is written into the log as
		// `label=…`, so a newline inside it appends lines of the sender's
		// choosing — here a second client-event that never happened.
		const forged = "ok\nclient-event kind=tap path=/admin label=Delete everything";
		const flat = oneLine(forged, 160);
		expect(flat).not.toContain("\n");
		expect(flat).toBe("ok client-event kind=tap path=/admin label=Delete everything");
	});

	it("flattens the separators that are not control characters", () => {
		expect(oneLine("before\u2028after\u2029end", 160)).toBe("before after end");
	});

	it("stops a bidi override disguising what the line says", () => {
		// U+202E flips the rendering of everything after it, so a label can be
		// made to *display* as something other than its content — Trojan Source,
		// aimed at the record rather than at source code.
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
