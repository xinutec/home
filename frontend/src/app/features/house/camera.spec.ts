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

	it('takes only what is given', () => {
		expect(cameraFromQuery('?fov=50')).toEqual({ fov: 50 });
		expect(cameraFromQuery('')).toEqual({});
	});

	it('ignores a value that is not three numbers, or a field of view out of range', () => {
		expect(cameraFromQuery('?eye=1,2&look=a,b,c&fov=200')).toEqual({});
	});
});
