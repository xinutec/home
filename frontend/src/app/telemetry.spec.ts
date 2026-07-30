import { describe, expect, it } from 'vitest';

import { labelFor } from './telemetry';

/** Build a detached element tree from markup, for reading labels out of it. */
function markup(html: string): Element {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host.firstElementChild!;
}

describe('labelFor', () => {
	it('reads the accessible name in preference to the text', () => {
		const el = markup('<button aria-label="Switch to dark theme">dark_mode</button>');
		expect(labelFor(el)).toBe('Switch to dark theme');
	});

	it("strips a Material icon's ligature name out of the label", () => {
		// The failure this exists for: mat-icon renders its ligature as *text*,
		// so without stripping it every icon+label control logs as
		// "thermostatClimate" and the trace is unreadable.
		const el = markup('<button><mat-icon>thermostat</mat-icon>Climate</button>');
		expect(labelFor(el)).toBe('Climate');
	});

	it('ignores anything hidden from assistive technology', () => {
		const el = markup('<button><span aria-hidden="true">×</span>Close</button>');
		expect(labelFor(el)).toBe('Close');
	});

	it('finds the control a tap landed inside', () => {
		// Taps land on the innermost node, which is almost never the button.
		const button = markup('<button><span class="label">Energy</span></button>');
		expect(labelFor(button.querySelector('.label'))).toBe('Energy');
	});

	it('says nothing for a tap that missed every control', () => {
		// What keeps the trace to things a person meant to do. Without this,
		// every click on the page body would be logged as an event.
		expect(labelFor(markup('<p>No readings yet.</p>'))).toBeNull();
		expect(labelFor(null)).toBeNull();
	});

	it('does not disturb the live DOM while reading a label', () => {
		// The icon is stripped on a clone. Reading a label must not delete the
		// icon from the page it was read off.
		const el = markup('<button><mat-icon>bolt</mat-icon>Power</button>');
		document.body.append(el);
		expect(labelFor(el)).toBe('Power');
		expect(el.querySelector('mat-icon')).not.toBeNull();
		el.remove();
	});
});
