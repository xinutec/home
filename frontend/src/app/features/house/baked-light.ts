import * as THREE from 'three';

import type { JointLight, Lightmap } from './bake-file';
import { checksum } from './bake-file';
import type { Lit } from './room-builder';
import { SKY, windowRadiance } from './sky';
import { GUTTER } from './unwrap';

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
 * at the cost of a flat one. Returns the lightmap's texture, if it applied; if not,
 * nothing changed.
 */
export function applyLightmap(
	scene: THREE.Scene,
	lit: Lit,
	map: Lightmap,
): THREE.DataTexture | undefined {
	if (map.width !== lit.atlas.width || map.height !== lit.atlas.height) return undefined;
	if (map.checksum !== roomChecksum(lit)) return undefined;
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
	return texture;
}

/** Where texels are drawn as points, one pixel each at its centre, in clip space. */
export function texelPoints(
	texels: ArrayLike<number>,
	width: number,
	height: number,
): Float32Array {
	const out = new Float32Array(texels.length * 3);
	for (let i = 0; i < texels.length; i++) {
		const t = texels[i];
		out[i * 3] = (((t % width) + 0.5) / width) * 2 - 1;
		out[i * 3 + 1] = ((Math.floor(t / width) + 0.5) / height) * 2 - 1;
	}
	return out;
}

/**
 * Every texel any joint changes, once, with its list of changes: `first` and
 * `count` say where in `entries` its list is, an entry four numbers (the joint, by
 * its index in `joints`, then the change of light, RGB). A texel takes a change
 * from as many joints as there are, as a kitchen's do from a dozen.
 */
export function jointLists(joints: JointLight[]): {
	texels: Uint32Array;
	first: Float32Array;
	count: Float32Array;
	entries: Float32Array;
} {
	// Each texel's place in the lists, by texel: an array, as a map of 380k is slow.
	let top = -1;
	for (const j of joints) for (const t of j.texels) top = Math.max(top, t);
	const place = new Int32Array(top + 1).fill(-1);
	const order: number[] = [];
	for (const j of joints) for (const t of j.texels) if (place[t] < 0) place[t] = order.push(t) - 1;
	const n = order.length;
	const count = new Float32Array(n);
	for (const j of joints) for (const t of j.texels) count[place[t]]++;
	const first = new Float32Array(n);
	for (let u = 1; u < n; u++) first[u] = first[u - 1] + count[u - 1];
	const entries = new Float32Array((n > 0 ? first[n - 1] + count[n - 1] : 0) * 4);
	const filled = new Float32Array(n);
	joints.forEach((j, k) =>
		j.texels.forEach((t, i) => {
			const u = place[t];
			const at = (first[u] + filled[u]++) * 4;
			entries[at] = k;
			for (let c = 0; c < 3; c++) entries[at + 1 + c] = j.delta[i * 3 + c];
		}),
	);
	return { texels: Uint32Array.from(order), first, count, entries };
}

/**
 * Which joint moves each texel of a `width` x `height` atlas, by its index in
 * `keys`: the texels of every mesh that moves on one (`userData.moves`), with their
 * gutter; -1 where the room stands still. A joint's change of light was baked with
 * every other joint shut, so it holds on another's part only while that is shut.
 */
export function jointOwners(
	meshes: THREE.Mesh[],
	keys: string[],
	width: number,
	height: number,
): Int16Array {
	const own = new Int16Array(width * height).fill(-1);
	for (const m of meshes) {
		const j = keys.indexOf(String(m.userData['moves'] ?? ''));
		if (j < 0) continue;
		const uv = m.geometry.getAttribute('uv1');
		for (let t = 0; t < uv.count; t += 3) {
			const xs = [0, 1, 2].map((k) => uv.getX(t + k) * width);
			const ys = [0, 1, 2].map((k) => uv.getY(t + k) * height);
			// A chart's triangles lie in its rectangle, which only its gutter surrounds.
			const [x0, x1] = [Math.floor(Math.min(...xs)) - GUTTER, Math.ceil(Math.max(...xs)) + GUTTER];
			const [y0, y1] = [Math.floor(Math.min(...ys)) - GUTTER, Math.ceil(Math.max(...ys)) + GUTTER];
			for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
				own.fill(j, y * width + Math.max(0, x0), y * width + Math.min(width, x1));
		}
	}
	return own;
}

/** Entries a row of the joint lights' list texture. */
const LIST_ROW = 2048;

/**
 * The light of the doors and drawers as they open, worked out on the GPU: the
 * lightmap is drawn into a texture of its own, which the room's materials read in
 * its place, and on each change every texel a joint changes is drawn again, as a
 * point: its light shut plus each joint's change of light (`JointLight`, baked with
 * it open) as far as that joint is open, never below none. What the GPU holds never
 * changes, only how far each joint is open, so nothing is uploaded a frame.
 */
export class JointLights {
	private readonly target: THREE.WebGLRenderTarget;
	private readonly points = new THREE.Scene();
	private readonly keys: string[];
	private readonly open: { value: number[] };
	private readonly owned: { dispose(): void }[] = [];

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		base: THREE.DataTexture,
		joints: JointLight[],
		/** The room's meshes as laid out in the lightmap: which of them moves on what. */
		meshes: THREE.Mesh[],
	) {
		const { width, height } = base.image;
		this.target = new THREE.WebGLRenderTarget(width, height, {
			type: THREE.HalfFloatType,
			format: THREE.RGBAFormat,
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			generateMipmaps: false,
			depthBuffer: false,
		});
		this.target.texture.channel = 1;
		// The lightmap as baked, copied in texel for texel.
		const copy = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: { base: { value: base } },
			vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
			fragmentShader: /* glsl */ `
				uniform sampler2D base;
				out vec4 outColor;
				void main() { outColor = texelFetch(base, ivec2(gl_FragCoord.xy), 0); }
			`,
		});
		const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copy);
		quad.frustumCulled = false;
		const once = new THREE.Scene();
		once.add(quad);
		this.draw(once);
		copy.dispose();
		quad.geometry.dispose();

		// Every texel any joint changes, once, as a point: its light shut, and where its
		// list of changes is in a texture of them all.
		const data: unknown = base.image.data;
		if (!(data instanceof Uint16Array)) throw new Error('the lightmap is not half floats');
		const lists = jointLists(joints);
		const n = lists.texels.length;
		const shut = new Float32Array(n * 3);
		lists.texels.forEach((t, u) => {
			for (let c = 0; c < 3; c++) shut[u * 3 + c] = THREE.DataUtils.fromHalfFloat(data[t * 4 + c]);
		});
		const rows = Math.max(1, Math.ceil(lists.entries.length / 4 / LIST_ROW));
		const half = new Uint16Array(LIST_ROW * rows * 4);
		lists.entries.forEach((v, i) => (half[i] = THREE.DataUtils.toHalfFloat(v)));
		const list = new THREE.DataTexture(half, LIST_ROW, rows, THREE.RGBAFormat, THREE.HalfFloatType);
		list.needsUpdate = true;
		const g = new THREE.BufferGeometry();
		g.setAttribute(
			'position',
			new THREE.Float32BufferAttribute(texelPoints(lists.texels, width, height), 3),
		);
		g.setAttribute('shut', new THREE.Float32BufferAttribute(shut, 3));
		g.setAttribute('first', new THREE.Float32BufferAttribute(lists.first, 1));
		g.setAttribute('count', new THREE.Float32BufferAttribute(lists.count, 1));
		const owners = jointOwners(
			meshes,
			joints.map((j) => j.key),
			width,
			height,
		);
		g.setAttribute(
			'owner',
			new THREE.Float32BufferAttribute(
				Float32Array.from(lists.texels, (t) => owners[t]),
				1,
			),
		);
		this.keys = joints.map((j) => j.key);
		this.open = { value: joints.map(() => 0) };
		const material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			defines: { JOINTS: Math.max(1, joints.length), LIST_ROW },
			uniforms: { open: this.open, list: { value: list } },
			blending: THREE.NoBlending,
			vertexShader: /* glsl */ `
				uniform float open[JOINTS];
				uniform highp sampler2D list;
				in vec3 shut;
				in float first;
				in float count;
				in float owner;
				out vec3 vLight;
				void main() {
					vec3 light = shut;
					int at = int(first);
					for (int i = 0; i < int(count); i++, at++) {
						vec4 e = texelFetch(list, ivec2(at % LIST_ROW, at / LIST_ROW), 0);
						// Another joint's change, on a part this texel's joint moves, as far as
						// that part is still shut: it was baked with it shut.
						float shut = owner >= 0.0 && int(owner) != int(e.x) ? 1.0 - open[int(owner)] : 1.0;
						light += shut * open[int(e.x)] * e.yzw;
					}
					vLight = max(light, vec3(0.0));
					gl_PointSize = 1.0;
					gl_Position = vec4(position.xy, 0.0, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				in vec3 vLight;
				out vec4 outColor;
				void main() { outColor = vec4(vLight, 1.0); }
			`,
		});
		const mesh = new THREE.Points(g, material);
		mesh.frustumCulled = false;
		this.points.add(mesh);
		this.owned.push(g, material, list);
		// Drawn once now, everything shut (what is there already), so its program is
		// compiled at load and not on the first frame a door moves.
		this.draw(this.points);
		// The room reads this texture in the baked one's place.
		scene.traverse((o) => {
			if (!(o instanceof THREE.Mesh)) return;
			const m: unknown = o.material;
			if (m instanceof THREE.MeshStandardMaterial && m.lightMap === base)
				m.lightMap = this.target.texture;
		});
	}

	/** Shows each joint `openness(key)` of the way open (0 shut, 1 as baked); true if
	 *  the light changed. */
	show(openness: (key: string) => number): boolean {
		const now = this.keys.map((k) => openness(k));
		if (now.every((v, k) => v - this.open.value[k] === 0)) return false;
		this.open.value = now;
		this.draw(this.points);
		return true;
	}

	dispose(): void {
		for (const r of this.owned) r.dispose();
		this.target.dispose();
	}

	/** Draws `scene` into the lightmap, over what is there. */
	private draw(scene: THREE.Scene): void {
		const before = this.renderer.getRenderTarget();
		const autoClear = this.renderer.autoClear;
		this.renderer.autoClear = false;
		this.renderer.setRenderTarget(this.target);
		this.renderer.render(scene, CLIP);
		this.renderer.setRenderTarget(before);
		this.renderer.autoClear = autoClear;
	}
}

/** A camera for what is drawn in clip space already: its matrices do nothing. */
const CLIP = new THREE.Camera();

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
