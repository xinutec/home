import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MAX_PATCHES, glowPatches } from './moving-shadow';

describe('glowPatches', () => {
	it('keeps a glowing bowl’s projected area seen from any way, in few patches', () => {
		// A hemisphere of radius 0.13 m opening up, its outside glowing down and out,
		// as a ceiling light's glass.
		const r = 0.13;
		const bowl = new THREE.Mesh(
			new THREE.SphereGeometry(r, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
		);
		bowl.position.set(0.6, 2.2, 1.8);
		const patches = glowPatches([bowl]);
		expect(patches.length).toBeLessThanOrEqual(MAX_PATCHES);
		// Seen from straight below, a hemisphere shows a disc: πr².
		const down = new THREE.Vector3(0, -1, 0);
		const below = patches.reduce((s, p) => s + Math.max(p.area.dot(down), 0), 0);
		expect(below / (Math.PI * r * r)).toBeCloseTo(1, 2);
		// From α below its level, as the floor sees it: πr²/2 (1 + sin α), exactly.
		for (const deg of [30, 45, 60]) {
			const alpha = THREE.MathUtils.degToRad(deg);
			const toward = new THREE.Vector3(Math.cos(alpha), -Math.sin(alpha), 0);
			const seen = patches.reduce((s, p) => s + Math.max(p.area.dot(toward), 0), 0);
			// Triangles in one patch facing a little toward and a little away cancel:
			// at most 6% short at 30°, less steeper.
			const share = seen / (((Math.PI * r * r) / 2) * (1 + Math.sin(alpha)));
			expect(share).toBeGreaterThan(0.94);
			expect(share).toBeLessThan(1.001);
		}
		// Each patch on the bowl's side of its middle.
		for (const p of patches) expect(p.at.y).toBeLessThanOrEqual(2.2 + 1e-6);
	});
});
