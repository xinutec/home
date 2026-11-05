import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JointLights, specularOnlyChunk } from './baked-light';

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

describe('JointLights', () => {
	/** A 3 × 2 lightmap, every texel 0.1, as half floats. */
	const lightmap = () => {
		const data = new Uint16Array(3 * 2 * 4).fill(THREE.DataUtils.toHalfFloat(0.1));
		return new THREE.DataTexture(data, 3, 2, THREE.RGBAFormat, THREE.HalfFloatType);
	};
	const red = (t: THREE.DataTexture, i: number) =>
		THREE.DataUtils.fromHalfFloat((t.image.data as Uint16Array)[i * 4]);

	it('adds each joint’s change of light as far as it is open, and takes it away shut', () => {
		const texture = lightmap();
		// The door lights texels 4 and 5, the drawer texel 5 too.
		const door = {
			key: 'door',
			at: 90,
			texels: Uint32Array.of(4, 5),
			delta: new Float32Array(6).fill(0.2),
		};
		const drawer = {
			key: 'drawer',
			at: 0.3,
			texels: Uint32Array.of(5),
			delta: new Float32Array(3).fill(0.4),
		};
		const light = new JointLights(texture, [door, drawer]);
		const open: Record<string, number> = { door: 0.5, drawer: 0 };
		expect(light.show((k) => open[k])).toBe(true);
		expect(red(texture, 4)).toBeCloseTo(0.2, 3);
		expect(red(texture, 0)).toBeCloseTo(0.1, 3);
		// Only the rows it changed go to the GPU: texels 4 and 5, of row 1.
		expect(texture.updateRanges).toEqual([{ start: 4 * 4, count: 2 * 4 }]);
		open['drawer'] = 1;
		light.show((k) => open[k]);
		expect(red(texture, 5)).toBeCloseTo(0.1 + 0.1 + 0.4, 3);
		// Nothing moved: nothing to draw again.
		expect(light.show((k) => open[k])).toBe(false);
		open['door'] = open['drawer'] = 0;
		light.show((k) => open[k]);
		expect(red(texture, 4)).toBe(THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(0.1)));
		expect(red(texture, 5)).toBe(THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(0.1)));
	});

	it('draws a frame of a door opening in a few milliseconds, at the house’s size', () => {
		// The real bake's: a 2048 × 980 atlas, nine joints of up to 114k texels, overlapping.
		const [w, h] = [2048, 980];
		const texture = new THREE.DataTexture(
			new Uint16Array(w * h * 4).fill(THREE.DataUtils.toHalfFloat(0.1)),
			w,
			h,
			THREE.RGBAFormat,
			THREE.HalfFloatType,
		);
		const joints = Array.from({ length: 9 }, (_, k) => {
			const texels = Uint32Array.from(
				{ length: 100_000 },
				(_, i) => (i * 7 + k * 50_000) % (w * h),
			);
			return { key: `j${k}`, at: 1, texels, delta: new Float32Array(texels.length * 3).fill(0.01) };
		});
		const light = new JointLights(texture, joints);
		const times: number[] = [];
		for (let f = 1; f <= 10; f++) {
			const start = performance.now();
			light.show((key) => (key === 'j0' ? f / 10 : 0));
			times.push(performance.now() - start);
			texture.updateRanges.length = 0;
		}
		times.sort((a, b) => a - b);
		expect(times[5]).toBeLessThan(40);
	});
});
