import { describe, expect, it } from 'vitest';
import { ownLight } from './baker';

/** An atlas 16 wide and 1 tall: `covered` and `traced` from strings, '#' for yes. */
function row(covered: string, traced: string) {
	const flags = (s: string) => Uint8Array.from([...s].map((c) => (c === '#' ? 1 : 0)));
	const c = flags(covered);
	const t = [...traced].flatMap((ch, i) => (ch === '#' ? [i] : []));
	const own = ownLight(c.length, 1, c, t);
	return [...c].map((_, i) => (own(i) ? 'o' : '.')).join('');
}

describe('ownLight', () => {
	it('owns a traced texel only where its neighbours were traced too', () => {
		// A chart of 8 texels, the left 6 traced: texel 5 is smoothed with untraced 6.
		expect(row('########........', '######..........').slice(0, 8)).toBe('ooooo...');
	});

	it('owns a gutter pixel only where every texel it is filled from was traced', () => {
		// A chart at 0-7, all traced; its gutter from 8 owned, as far as no other
		// chart's untraced texel (at 14) is within reach.
		expect(row('########......##', '########........')).toBe('ooooooooo.......');
	});

	it('takes as its own what nothing reads, far from every surface', () => {
		expect(row('#...............', '................').slice(6)).toBe('oooooooooo');
	});
});
