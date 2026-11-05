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

/** Where a room's reflection probe sees it from: its middle, at a standing eye. */
const PROBE_HEIGHT = 1.4;
/** A probe's cube faces, pixels a side: sharp enough for the TV's glass. */
const PROBE_SIZE = 256;

/**
 * Reflections, as games make them: each room's lit surroundings captured once into
 * a cube map from its middle (a reflection probe), prefiltered by roughness, and
 * reflected by every surface in that room by its Fresnel and roughness. A material
 * used in several rooms is copied, one per room, each with its room's probe. The
 * light on a surface stays the lightmap's alone: three would add the probe as
 * diffuse light too, which the lightmap already holds, so that one line goes from
 * the shader. Returns the probes and copies, for disposal.
 */
export function addReflections(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	lit: Lit,
): { dispose(): void }[] {
	const owned: { dispose(): void }[] = [];
	const byRoom = new Map<string, THREE.Mesh[]>();
	for (const mesh of lit.meshes) {
		const room = String(mesh.userData['room']);
		byRoom.set(room, [...(byRoom.get(room) ?? []), mesh]);
	}
	// Every probe is captured before any surface reflects: none sees another's reflections.
	const pmrem = new THREE.PMREMGenerator(renderer);
	const probes = new Map<string, THREE.Texture>();
	for (const [room, meshes] of byRoom) {
		const at = lit.centres.get(room);
		const centre = at
			? new THREE.Vector3(at.x, PROBE_HEIGHT, at.z)
			: new THREE.Box3().setFromObject(meshes[0]).getCenter(new THREE.Vector3());
		if (!at) centre.y = PROBE_HEIGHT;
		// A render target holds linear radiance: three tone maps only the screen.
		const cube = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, { type: THREE.HalfFloatType });
		const camera = new THREE.CubeCamera(0.05, 50, cube);
		camera.position.copy(centre);
		camera.update(renderer, scene);
		const probe = pmrem.fromCubemap(cube.texture);
		owned.push(cube, probe);
		probes.set(room, probe.texture);
	}
	pmrem.dispose();

	const specularOnly = specularOnlyChunk();
	// The first room to use a material keeps it; each other room gets a copy.
	const firstRoom = new Map<THREE.Material, string>();
	const copies = new Map<string, THREE.MeshStandardMaterial>();
	const done = new Set<THREE.Material>();
	for (const [room, meshes] of byRoom)
		for (const mesh of meshes) {
			const material = mesh.material;
			if (!(material instanceof THREE.MeshStandardMaterial) || !material.lightMap) continue;
			if (!firstRoom.has(material)) firstRoom.set(material, room);
			const key = `${room}|${material.uuid}`;
			let own = firstRoom.get(material) === room ? material : copies.get(key);
			if (!own) {
				own = material.clone();
				copies.set(key, own);
				owned.push(own);
			}
			mesh.material = own;
			if (done.has(own)) continue;
			done.add(own);
			own.envMap = probes.get(room) ?? null;
			own.envMapIntensity = 1;
			own.onBeforeCompile = (shader) => {
				shader.fragmentShader = shader.fragmentShader.replace(
					'#include <lights_fragment_maps>',
					specularOnly,
				);
			};
			own.needsUpdate = true;
		}
	return owned;
}

/** three's indirect-light chunk without the environment's diffuse light: the
 *  surface reflects the probe, and its light is the lightmap's. The reflection is
 *  normalized as games do it: scaled by the surface's baked light over the probe's
 *  light from the same side, at most 1, so a surface in shadow (a sofa's arm with
 *  the bay behind it) does not reflect the windows the probe sees in full. */
export function specularOnlyChunk(): string {
	const chunk = THREE.ShaderChunk.lights_fragment_maps;
	const normalized = `#ifdef USE_LIGHTMAP
		const vec3 luma = vec3( 0.2126, 0.7152, 0.0722 );
		float probeLight = dot( getIBLIrradiance( geometryNormal ), luma );
		float hereLight = dot( lightMapIrradiance, luma );
		reflectionScale = clamp( hereLight / max( probeLight, 1e-8 ), 0.0, 1.0 );
	#endif`;
	const swaps: [string, string][] = [
		['iblIrradiance += getIBLIrradiance( geometryNormal );', normalized],
		[
			'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
			'radiance += reflectionScale * getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
		],
	];
	let out = `float reflectionScale = 1.0;\n${chunk}`;
	for (const [from, to] of swaps) {
		const next = out.replace(from, to);
		if (next === out)
			throw new Error("three's lights_fragment_maps changed: the probe would light surfaces twice");
		out = next;
	}
	return out;
}
