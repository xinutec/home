import * as THREE from 'three';

import type { Lightmap } from './bake-file';
import { checksum } from './bake-file';
import type { Lit } from './room-builder';
import { SKY, windowRadiance } from './sky';

/** The merged room's fingerprint, as its lightmap stores it: every vertex's place
 *  and its lightmap coordinates. */
export function roomChecksum(lit: Lit): number {
	return checksum(
		lit.meshes.flatMap((m) => {
			const uv = m.geometry.getAttribute('uv1');
			return [m.geometry.getAttribute('position').array, ...(uv ? [uv.array] : [])];
		}),
	);
}

/**
 * Draws the merged room in its baked light, if the lightmap is for exactly this
 * geometry and layout: every surface reads the light on it from the map, as three
 * draws a light map (its irradiance), which stands in for every light in the
 * scene. Frosted panes glow with the daylight they let in, clear ones show the
 * sky; no light is computed while drawing, so a phone draws the path-traced look
 * at the cost of a flat one. Returns whether it applied; if not, nothing changed.
 */
export function applyLightmap(scene: THREE.Scene, lit: Lit, map: Lightmap): boolean {
	if (map.width !== lit.atlas.width || map.height !== lit.atlas.height) return false;
	if (map.checksum !== roomChecksum(lit)) return false;
	const texture = new THREE.DataTexture(
		map.data,
		map.width,
		map.height,
		THREE.RGBAFormat,
		THREE.HalfFloatType,
	);
	texture.channel = 1;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	const done = new Set<THREE.Material>();
	for (const mesh of lit.meshes) {
		mesh.castShadow = mesh.receiveShadow = false;
		const material = mesh.material;
		if (Array.isArray(material) || done.has(material)) continue;
		done.add(material);
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
		if (!(material instanceof THREE.MeshStandardMaterial)) continue;
		material.lightMap = texture;
		material.lightMapIntensity = 1;
		material.envMapIntensity = 0;
		material.needsUpdate = true;
	}

	// The lightmap is all the light there is.
	const lights: THREE.Object3D[] = [];
	scene.traverse((o) => {
		if (o instanceof THREE.Light) lights.push(o);
	});
	for (const l of lights) l.removeFromParent();
	scene.environment = null;
	scene.background = new THREE.Color(SKY[0], SKY[1], SKY[2]);
	return true;
}

/** Where the reflection probe sees the room from: its middle, at a standing eye. */
const PROBE_HEIGHT = 1.4;
/** The probe's cube faces, pixels a side: sharp enough for the TV's glass. */
const PROBE_SIZE = 256;

/**
 * Reflections, as games make them: the lit room captured once into a cube map from
 * its middle (a reflection probe), prefiltered by roughness, and reflected by every
 * surface by its Fresnel and roughness. The light on a surface stays the lightmap's
 * alone: three would add the probe as diffuse light too, which the lightmap already
 * holds, so that one line goes from the shader. Returns the probe, for disposal.
 */
export function addReflections(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	lit: Lit,
): THREE.WebGLRenderTarget[] {
	const box = new THREE.Box3();
	for (const m of lit.meshes) box.expandByObject(m);
	const centre = box.getCenter(new THREE.Vector3());
	centre.y = PROBE_HEIGHT;
	// A render target holds linear radiance: three tone maps only the screen.
	const cube = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, { type: THREE.HalfFloatType });
	const camera = new THREE.CubeCamera(0.05, 50, cube);
	camera.position.copy(centre);
	camera.update(renderer, scene);
	const pmrem = new THREE.PMREMGenerator(renderer);
	const probe = pmrem.fromCubemap(cube.texture);
	pmrem.dispose();

	const specularOnly = specularOnlyChunk();
	const done = new Set<THREE.Material>();
	for (const mesh of lit.meshes) {
		const material = mesh.material;
		if (Array.isArray(material) || done.has(material)) continue;
		done.add(material);
		if (!(material instanceof THREE.MeshStandardMaterial) || !material.lightMap) continue;
		material.envMap = probe.texture;
		material.envMapIntensity = 1;
		material.onBeforeCompile = (shader) => {
			shader.fragmentShader = shader.fragmentShader.replace(
				'#include <lights_fragment_maps>',
				specularOnly,
			);
		};
		material.needsUpdate = true;
	}
	return [cube, probe];
}

/** three's indirect-light chunk without the environment's diffuse light: the
 *  surface reflects the probe, and its light is the lightmap's. */
export function specularOnlyChunk(): string {
	const chunk = THREE.ShaderChunk.lights_fragment_maps;
	const out = chunk.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');
	if (out === chunk)
		throw new Error("three's lights_fragment_maps changed: the probe would light surfaces twice");
	return out;
}
