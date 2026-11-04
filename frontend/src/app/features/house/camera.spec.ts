import { describe, expect, it } from 'vitest';
import { cameraFromQuery } from './camera';

describe('cameraFromQuery', () => {
	it('reads eye, look and the vertical field of view', () => {
		expect(cameraFromQuery('?eye=0.1,1.5,2.8&look=-0.6,1.1,-0.3&fov=67')).toEqual({
			eye: [0.1, 1.5, 2.8],
			look: [-0.6, 1.1, -0.3],
			fov: 67,
		});
	});

	it('reads a path-traced sample count and an exposure', () => {
		expect(cameraFromQuery('?trace=256&exposure=1.5')).toEqual({ trace: 256, exposure: 1.5 });
		expect(cameraFromQuery('?trace=0&exposure=-1')).toEqual({});
	});

	it('reads the night', () => {
		expect(cameraFromQuery('?trace=64&night')).toEqual({ trace: 64, night: true });
	});

	it('reads an export of the physical scene', () => {
		expect(cameraFromQuery('?export')).toEqual({ export: true });
		expect(cameraFromQuery('?trace=64')).not.toHaveProperty('export');
	});

	it('reads a linear tone, and nothing else as one', () => {
		expect(cameraFromQuery('?tone=linear')).toEqual({ linear: true });
		expect(cameraFromQuery('?tone=aces')).toEqual({});
	});

	it('reads a request for frame statistics, and for a bake', () => {
		expect(cameraFromQuery('?stats')).toEqual({ stats: true });
		expect(cameraFromQuery('?bake=512')).toEqual({ bake: 512 });
		expect(cameraFromQuery('?bake=0')).toEqual({});
	});

	it('takes only what is given', () => {
		expect(cameraFromQuery('?fov=50')).toEqual({ fov: 50 });
		expect(cameraFromQuery('')).toEqual({});
	});

	it('ignores a value that is not three numbers, or a field of view out of range', () => {
		expect(cameraFromQuery('?eye=1,2&look=a,b,c&fov=200')).toEqual({});
	});
});
