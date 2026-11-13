import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import { walkerWorld } from './footing';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse, solidTag } from './room-builder';

const house = withModels(json as unknown as HouseScene);

/** The real house's meshes, as `buildHouse` makes them. */
function built(): THREE.Mesh[] {
	const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
	buildHouse(stage, house, new MaterialLibrary(stage.own, false), false, false);
	return stage.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

describe('walkerWorld', () => {
	it('makes each fixed part its box, and leaves doors, drawers and things that move out', () => {
		const meshes = built();
		const fixedParts = meshes.filter(
			(m) =>
				solidTag(m)?.kind === 'part' &&
				m.userData['moves'] === undefined &&
				m.userData['movable'] === undefined,
		);
		const { boxes } = walkerWorld(meshes);
		expect(boxes.length).toBe(fixedParts.length);
		// The sideboard's left drawer moves: no box stands where it is shut.
		const drawer = new THREE.Box3();
		for (const m of meshes)
			if (m.userData['moves'] === 'living-sideboard/drawer-left') drawer.expandByObject(m);
		const middle = drawer.getCenter(new THREE.Vector3());
		const inside = boxes.filter(({ half, middle: at, turn }) =>
			at
				.clone()
				.sub(middle)
				.applyQuaternion(turn.clone().invert())
				.toArray()
				.every((v, i) => Math.abs(v) < half.getComponent(i)),
		);
		expect(inside.map(({ half }) => half.toArray())).toEqual([]);
	});

	it('keeps the rooms’ shells as their triangles', () => {
		const meshes = built();
		const { shell } = walkerWorld(meshes);
		expect(shell.indices.length % 3).toBe(0);
		expect(shell.indices.length).toBeGreaterThan(0);
		expect(Math.max(...shell.indices)).toBeLessThan(shell.vertices.length / 3);
	});
});
