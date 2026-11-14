import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { jointLists, specularOnlyChunk, texelOwners, texelPoints } from './baked-light';

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

describe('jointLists', () => {
	const joint = (key: string, texels: number[], delta: number[]) => ({
		key,
		at: 1,
		texels: Uint32Array.from(texels),
		delta: Float32Array.from(delta),
	});

	it('lists each texel once, with every joint that changes it and by how much', () => {
		const l = jointLists([joint('a', [5, 9], [1, 2, 3, 4, 5, 6]), joint('b', [9], [-1, -2, -3])]);
		expect([...l.texels]).toEqual([5, 9]);
		expect([...l.first]).toEqual([0, 1]);
		expect([...l.count]).toEqual([1, 2]);
		// Joint, then its change: texel 5's one entry, then texel 9's two.
		expect([...l.entries]).toEqual([0, 1, 2, 3, 0, 4, 5, 6, 1, -1, -2, -3]);
	});

	it('lists the texels the first changes touch before those only later ones do', () => {
		// A joint's texels first, then a lamp's: a moving door redraws only the first.
		const l = jointLists([
			joint('door', [7, 2], [0, 0, 0, 0, 0, 0]),
			joint('lamp', [1, 2, 8], [0, 0, 0, 0, 0, 0, 0, 0, 0]),
		]);
		expect([...l.texels]).toEqual([7, 2, 1, 8]);
	});

	it('takes as many joints on one texel as there are', () => {
		const many = Array.from({ length: 11 }, (_, k) => joint(`j${k}`, [3], [k, 0, 0]));
		const l = jointLists(many);
		expect([...l.count]).toEqual([11]);
		expect(Array.from({ length: 11 }, (_, k) => l.entries[k * 4])).toEqual(many.map((_, k) => k));
	});
});

describe('texelOwners', () => {
	/** A square of two triangles at lightmap coordinates u0..u1, v0..v1, in `room`. */
	function square(u0: number, u1: number, v0: number, v1: number, room: string): THREE.Mesh {
		const g = new THREE.BufferGeometry();
		const uv = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
		g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
		g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv, 2));
		const m = new THREE.Mesh(g);
		m.userData['room'] = room;
		return m;
	}

	it('says whose each texel is, its gutter too, and none where no chart is', () => {
		// A 16 x 1 atlas: the living room's chart at texels 0-3, the dining room's at 8-11.
		const rooms = ['living', 'dining'];
		const own = texelOwners(
			[square(0, 4 / 16, 0, 1, 'living'), square(8 / 16, 12 / 16, 0, 1, 'dining')],
			(m) => rooms.indexOf(String(m.userData['room'])),
			16,
			1,
		);
		expect([...own]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1]);
	});
});
