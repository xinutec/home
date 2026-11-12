import { beforeEach, describe, expect, it } from 'vitest';
import { FEATURES, readFeature, writeFeature } from './view-settings';

describe('the view settings', () => {
	beforeEach(() => {
		for (const f of FEATURES)
			localStorage.removeItem(f.feature === 'fine' ? 'house.image' : `house.${f.feature}`);
	});

	it('draws fast unless fine was chosen, with the rest on', () => {
		expect(readFeature('fine')).toBe(false);
		expect(readFeature('shadows')).toBe(true);
		expect(readFeature('directional')).toBe(true);
	});

	it('keeps each choice, the fine image under the key it always had', () => {
		writeFeature('fine', true);
		expect(localStorage.getItem('house.image')).toBe('fine');
		expect(readFeature('fine')).toBe(true);
		writeFeature('occlusion', false);
		expect(readFeature('occlusion')).toBe(false);
		writeFeature('occlusion', true);
		expect(readFeature('occlusion')).toBe(true);
	});
});
