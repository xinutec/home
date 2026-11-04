import * as THREE from 'three';

import type { Bake } from './bake-file';
import { checksum } from './bake-file';
import { SKY, windowRadiance } from './sky';

/** The merged room's fingerprint, as its bake stores it. */
export function roomChecksum(meshes: THREE.Mesh[]): number {
	return checksum(meshes.map((m) => m.geometry.getAttribute('position').array));
}

/**
 * Draws the merged room in its baked light, if the bake is for exactly this
 * geometry: each vertex carries the irradiance on its front and its back, which
 * stands in for every light in the scene. Frosted panes glow with the daylight
 * they let in, clear ones show the sky; no light is computed while drawing, so a
 * phone draws the path-traced look at the cost of a flat one. Returns whether the
 * bake applied; if not, nothing has changed.
 */
export function applyBake(scene: THREE.Scene, meshes: THREE.Mesh[], bake: Bake): boolean {
	const count = meshes.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0);
	if (bake.front.length !== count * 3 || bake.checksum !== roomChecksum(meshes)) return false;

	let at = 0;
	const patched = new Set<THREE.Material>();
	for (const mesh of meshes) {
		const n = mesh.geometry.getAttribute('position').count;
		const span = (a: Float32Array) =>
			new THREE.Float32BufferAttribute(a.slice(at * 3, (at + n) * 3), 3);
		mesh.geometry.setAttribute('bakedFront', span(bake.front));
		mesh.geometry.setAttribute('bakedBack', span(bake.back));
		at += n;
		mesh.castShadow = mesh.receiveShadow = false;
		const material = mesh.material;
		if (Array.isArray(material) || patched.has(material)) continue;
		patched.add(material);
		if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
			// Glass, cheaply: a frosted pane as the light it lets in, a clear one nearly invisible.
			const frosted = material.roughness > 0.1;
			const glow = frosted ? windowRadiance(material.transmission) : 0;
			material.transmission = 0;
			material.transparent = !frosted;
			material.opacity = frosted ? 1 : 0.12;
			material.emissive.setRGB(SKY[0] * glow, SKY[1] * glow, SKY[2] * glow);
			material.color.setRGB(0, 0, 0);
			material.needsUpdate = true;
			continue;
		}
		material.onBeforeCompile = (shader) => {
			shader.vertexShader = shader.vertexShader
				.replace(
					'#include <common>',
					'#include <common>\nattribute vec3 bakedFront;\nattribute vec3 bakedBack;\nvarying vec3 vBakedFront;\nvarying vec3 vBakedBack;',
				)
				.replace(
					'#include <begin_vertex>',
					'#include <begin_vertex>\nvBakedFront = bakedFront;\nvBakedBack = bakedBack;',
				);
			shader.fragmentShader = shader.fragmentShader
				.replace(
					'#include <common>',
					'#include <common>\nvarying vec3 vBakedFront;\nvarying vec3 vBakedBack;',
				)
				.replace(
					'#include <lights_fragment_maps>',
					'#include <lights_fragment_maps>\nirradiance += gl_FrontFacing ? vBakedFront : vBakedBack;',
				);
		};
		material.customProgramCacheKey = () => 'baked';
		if (material instanceof THREE.MeshStandardMaterial) material.envMapIntensity = 0;
		material.needsUpdate = true;
	}

	// The bake is all the light there is.
	const lights: THREE.Object3D[] = [];
	scene.traverse((o) => {
		if (o instanceof THREE.Light) lights.push(o);
	});
	for (const l of lights) l.removeFromParent();
	scene.environment = null;
	scene.background = new THREE.Color(SKY[0], SKY[1], SKY[2]);
	return true;
}
