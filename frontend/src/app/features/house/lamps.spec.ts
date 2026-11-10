import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import type { HouseScene } from './house.model';
import { Lamps, shownColour } from './lamps';
import { MaterialLibrary } from './materials';
import { mergeStatic } from './merge';
import { buildHouse } from './room-builder';
import { LAMP_BAKED_LUMENS, kelvinColour } from './sky';

const house = withModels(json as unknown as HouseScene);

/** The house as the room view draws it: built, then merged. */
function drawn(scene = house): { meshes: THREE.Mesh[]; lamps: Lamps } {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	const meshes = mergeStatic(stage.scene, () => undefined);
	return { meshes, lamps: new Lamps(scene, meshes) };
}

/** A ray from 30 cm below a mesh's middle, straight up into it. */
function under(m: THREE.Mesh): THREE.Ray {
	const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
	return new THREE.Ray(c.clone().setY(c.y - 0.3), new THREE.Vector3(0, 1, 0));
}

describe('lamps', () => {
	it('draws every light of the scene, its glowing part apart', () => {
		const { meshes, lamps } = drawn();
		expect(lamps.keys().sort()).toEqual((house.lights ?? []).map((l) => l.id).sort());
		for (const m of meshes.filter((m) => m.userData['glows'] === true)) {
			const others = meshes.filter((o) => o !== m && o.userData['lamp'] === m.userData['lamp']);
			expect(others.every((o) => o.userData['glows'] === false)).toBe(true);
		}
	});

	it('is switched by a tap, and it is evening while one is on', () => {
		const { meshes, lamps } = drawn();
		const glass = meshes.find(
			(m) => m.userData['lamp'] === 'living-ceiling-lamp' && m.userData['glows'] === true,
		);
		if (!glass) throw new Error('no ceiling glass');
		const key = lamps.pick(under(glass));
		expect(key).toBe('living-ceiling-lamp');
		expect(lamps.evening).toBe(false);
		expect(lamps.weight('living-ceiling-lamp')).toEqual([0, 0, 0]);
		lamps.toggle('living-ceiling-lamp');
		expect(lamps.evening).toBe(true);
		const k = 806 / LAMP_BAKED_LUMENS;
		const [r, g, b] = shownColour(2700);
		const w = lamps.weight('living-ceiling-lamp');
		[r * k, g * k, b * k].forEach((c, i) => expect(w[i]).toBeCloseTo(c));
		lamps.toggle('living-ceiling-lamp');
		expect(lamps.evening).toBe(false);
	});

	it('glows only while on, from a material of its own', () => {
		const { meshes, lamps } = drawn();
		const glass = meshes.find(
			(m) => m.userData['lamp'] === 'living-ceiling-lamp' && m.userData['glows'] === true,
		);
		if (!glass) throw new Error('no ceiling glass');
		const shared = glass.material;
		lamps.ownMaterials();
		expect(glass.material).not.toBe(shared);
		const emissive = () => (glass.material as THREE.MeshStandardMaterial).emissive.getHex();
		lamps.showGlow();
		expect(emissive()).toBe(0);
		lamps.toggle('living-ceiling-lamp');
		lamps.showGlow();
		expect(emissive()).not.toBe(0);
	});

	it('shows warm white warm, but less so than it is', () => {
		const [r, g, b] = shownColour(2700);
		expect(r).toBeGreaterThan(g);
		expect(g).toBeGreaterThan(b);
		const [r0, , b0] = kelvinColour(2700);
		expect(r / b).toBeLessThan(r0 / b0);
		const white = shownColour(3500);
		white.forEach((c) => expect(c).toBeCloseTo(1));
	});

	it('refuses a light whose piece or glowing part is not there', () => {
		const lights = house.lights ?? [];
		const noPart = { ...house, lights: [{ ...lights[0], glows: 'bulb' }] };
		expect(() => drawn(noPart)).toThrow(/has no part bulb/);
		const noPiece = { ...house, lights: [{ ...lights[0], piece: 'nowhere' }] };
		expect(() => drawn(noPiece)).toThrow(/no piece nowhere/);
	});
});
