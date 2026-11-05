import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { specularOnlyChunk, texelPoints } from './baked-light';

describe('specularOnlyChunk', () => {
	it('keeps the probe as reflection and the lightmap as the only diffuse light', () => {
		const chunk = specularOnlyChunk();
		expect(chunk).not.toContain('iblIrradiance +=');
		expect(chunk).toContain('getIBLRadiance');
		expect(chunk).toContain('irradiance += lightMapIrradiance;');
		expect(THREE.ShaderChunk.lights_fragment_maps).toContain('getIBLIrradiance');
	});

	it('dims the reflection where the baked light is darker than the probe’s', () => {
		const chunk = specularOnlyChunk();
		expect(chunk).toContain('radiance += reflectionScale * getIBLRadiance(');
		expect(chunk).toMatch(/reflectionScale = clamp\( hereLight \/ max\( probeLight/);
	});
});

describe('texelPoints', () => {
	it('puts each texel’s point at its centre, row 0 at the bottom as the lightmap reads it', () => {
		// A 4 × 2 lightmap: texel 0 is the bottom left, texel 7 the top right.
		const p = texelPoints([0, 7], 4, 2);
		expect([...p.subarray(0, 2)]).toEqual([-0.75, -0.5]);
		expect([...p.subarray(3, 5)]).toEqual([0.75, 0.5]);
	});
});
