import { beforeEach, describe, expect, it } from 'vitest';
import { readGlow, writeGlow } from './glow-setting';
import { GLOW_DEFAULT } from './image-stage';

describe('the glow setting', () => {
	beforeEach(() => localStorage.removeItem('house.glow'));

	it('starts at the default, and keeps what is set', () => {
		expect(readGlow()).toBe(GLOW_DEFAULT);
		writeGlow(0);
		expect(readGlow()).toBe(0);
		writeGlow(0.6);
		expect(readGlow()).toBe(0.6);
	});

	it('takes the default for a kept value out of range', () => {
		localStorage.setItem('house.glow', '3');
		expect(readGlow()).toBe(GLOW_DEFAULT);
		localStorage.setItem('house.glow', 'much');
		expect(readGlow()).toBe(GLOW_DEFAULT);
	});
});
