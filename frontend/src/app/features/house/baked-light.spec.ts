import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { specularOnlyChunk } from './baked-light';

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
