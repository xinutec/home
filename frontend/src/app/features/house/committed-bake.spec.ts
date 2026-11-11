import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import json from '../../../../../scenes/house.json';
import { withModels } from './assembly';
import { decodeLightmap } from './bake-file';
import { roomChecksum } from './baked-light';
import type { HouseScene } from './house.model';
import { MaterialLibrary } from './materials';
import { buildHouse, litRoom } from './room-builder';

/** scenes/house.bake, found up from where the tests run (the test runner bundles
 *  this file, so it has no path of its own to go by). */
function committedBake(): string {
	for (let dir = process.cwd(); ; dir = dirname(dir)) {
		const file = join(dir, 'scenes/house.bake');
		if (existsSync(file)) return file;
		if (dirname(dir) === dir) throw new Error('no scenes/house.bake above the tests');
	}
}

describe('scenes/house.bake', () => {
	it('fits the house as built: a bake that does not is dropped, and the page draws without its light', async () => {
		const bytes = readFileSync(committedBake());
		const map = await decodeLightmap(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			(b) => Promise.resolve(new Uint8Array(gunzipSync(b))),
		);
		if (!map) throw new Error('scenes/house.bake does not decode');
		const scene = withModels(json as unknown as HouseScene);
		const stage = { scene: new THREE.Scene(), own: <T>(r: T) => r };
		buildHouse(stage, scene, new MaterialLibrary(stage.own, false), false, false);
		const lit = litRoom(stage, scene, map.layout);
		expect([lit.atlas.width, lit.atlas.height], 'its atlas').toEqual([map.width, map.height]);
		expect(roomChecksum(lit), 'its geometry: bake again (frontend/e2e/bake.ts)').toBe(map.checksum);
	});
});
