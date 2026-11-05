import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { partsOf } from './assembly';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse } from './room-builder';
import type { SolidTag } from './room-builder';

const scene = json as unknown as HouseScene;

/** The real house built as the page draws it, without a browser: no renderer, no textures. */
function built(): THREE.Mesh[] {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
	return stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

describe('buildHouse', () => {
	const meshes = built();
	const tags = meshes.map((m) => m.userData['solid'] as SolidTag | undefined);

	it('names what every mesh it draws is', () => {
		expect(tags.filter((t) => !t)).toEqual([]);
	});

	it('draws every part of every piece, once', () => {
		const drawn = tags
			.filter((t) => t?.kind === 'part')
			.map((t) => (t?.kind === 'part' ? `${t.piece}/${t.part}` : ''));
		const wanted = scene.furniture.flatMap((f) =>
			partsOf(f).map((p) => `${f.id ?? f.name}/${p.id}`),
		);
		expect(drawn.sort()).toEqual(wanted.sort());
	});

	it('draws the room surfaces the physics must see', () => {
		const kinds = new Set(tags.map((t) => t?.kind));
		for (const k of ['wall', 'floor', 'ceiling', 'coving', 'skirting', 'frame', 'glass', 'passage'])
			expect(kinds).toContain(k);
	});
});
