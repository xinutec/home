import { beforeEach, describe, expect, it } from 'vitest';
import { readFine, writeFine } from './image-setting';

describe('the image setting', () => {
	beforeEach(() => localStorage.removeItem('house.image'));

	it('draws fast unless fine was chosen, and keeps the choice', () => {
		expect(readFine()).toBe(false);
		writeFine(true);
		expect(readFine()).toBe(true);
		writeFine(false);
		expect(readFine()).toBe(false);
	});
});
