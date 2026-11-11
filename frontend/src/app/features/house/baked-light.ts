import * as THREE from 'three';

import { type LightChange, type Lightmap, checksum, pairOf } from './bake-file';
import type { Lit } from './room-builder';
import type { MovingShadow } from './moving-shadow';
import type { ProbeLight } from './probes';
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
			// The daylight it lets in, for the evening to take away (`showDaylight`).
			material.userData['daylight'] = material.emissive.clone();
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
 * Every texel any change (a joint's, a lamp's) touches, once, in the order the
 * changes first meet them, with its list of changes: `first` and `count` say where
 * in `entries` its list is, an entry four numbers (the change, by its index in
 * `joints`, then the change of light, RGB). A texel takes a change from as many
 * joints as there are, as a kitchen's do from a dozen.
 */
export function jointLists(joints: LightChange[]): {
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
	return texelOwners(meshes, (m) => keys.indexOf(String(m.userData['moves'] ?? '')), width, height);
}

/** Each texel of a `width` x `height` atlas as `of` its mesh says (-1 for none),
 *  with its chart's gutter; -1 where no mesh is. */
export function texelOwners(
	meshes: THREE.Mesh[],
	of: (mesh: THREE.Mesh) => number,
	width: number,
	height: number,
): Int16Array {
	const own = new Int16Array(width * height).fill(-1);
	for (const m of meshes) {
		const j = of(m);
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

/** Daylight on the room's windows: a frosted pane glows with it (`applyLightmap`
 *  keeps its glow), and the sky behind the clear ones is the day's, or the night's. */
export function showDaylight(scene: THREE.Scene, daylight: number): void {
	const done = new Set<THREE.Material>();
	scene.traverse((o) => {
		if (!(o instanceof THREE.Mesh)) return;
		const m: unknown = o.material;
		if (!(m instanceof THREE.MeshStandardMaterial) || done.has(m)) return;
		done.add(m);
		const day: unknown = m.userData['daylight'];
		if (day instanceof THREE.Color) m.emissive.copy(day).multiplyScalar(daylight);
	});
	const sky = new THREE.Color(SKY[0], SKY[1], SKY[2]).multiplyScalar(daylight);
	scene.background = sky.lerp(NIGHT, 1 - daylight);
}

/** The sky outside after dark, linear: a deep blue, barely lit. */
const NIGHT = new THREE.Color(0.002, 0.003, 0.008);

/** Entries a row of the changes' list texture. */
const LIST_ROW = 2048;

/**
 * The light as it changes, worked out on the GPU: the doors and drawers as they
 * open, the lamps as they are switched, the daylight as it goes. The lightmap is
 * drawn into a texture of its own, which the room's materials read in its place,
 * scaled by the daylight; and on each change every texel a joint or lamp changes
 * is drawn again, as a point: the daylight times its light shut plus each joint's
 * change of light (`LightChange`, baked with it open) as far as that joint is open,
 * plus each lamp's light by its weight (`Lamps.weight`) and each pair's change of
 * it (a joint opened under a lamp) by both, never below none. What the GPU holds
 * never changes, only how far each joint is open, how bright each lamp is and the
 * daylight, so nothing is uploaded a frame.
 *
 * A joint's change was baked in daylight, so it goes with the daylight; a lamp's
 * light with every joint shut, and a pair's with its joint alone open.
 */
export class LiveLight {
	private readonly target: THREE.WebGLRenderTarget;
	private readonly points = new THREE.Scene();
	private readonly copy = new THREE.Scene();
	private readonly keys: string[];
	private readonly lampKeys: string[];
	private readonly open: { value: number[] };
	private readonly lamps: { value: THREE.Vector3[] };
	/** Each pair's joint and lamp, by index, and its weight: how far open the joint
	 *  is times the lamp's weight. */
	private readonly pairs: { joint: number; lamp: number }[];
	private readonly pairWeights: { value: THREE.Vector3[] };
	/** The lamp whose shadows the moving things cast, by index, or -1. */
	private readonly casting = { value: -1 };
	private readonly daylight: { value: number };
	private readonly owned: { dispose(): void }[] = [];
	/** The points, and how many of them, from the first, some joint changes. */
	private readonly cloud: THREE.Points;
	private readonly jointTexels: number;

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		base: THREE.DataTexture,
		joints: LightChange[],
		lamps: LightChange[],
		pairs: LightChange[],
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
		// The lightmap as baked, copied in texel for texel, times the daylight: drawn
		// again only when the daylight changes.
		this.daylight = { value: 1 };
		const copy = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			uniforms: { base: { value: base }, daylight: this.daylight },
			vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
			fragmentShader: /* glsl */ `
				uniform sampler2D base;
				uniform float daylight;
				out vec4 outColor;
				void main() {
					vec4 shut = texelFetch(base, ivec2(gl_FragCoord.xy), 0);
					// No lamp's light here: none of it is the casting lamp's (MovingShadow).
					outColor = vec4(shut.rgb * daylight, 0.0);
				}
			`,
		});
		const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copy);
		quad.frustumCulled = false;
		this.copy.add(quad);
		this.owned.push(copy, quad.geometry);
		this.draw(this.copy);

		// Every texel any joint or lamp changes, once, as a point: its light shut, and
		// where its list of changes is in a texture of them all, the joints' first.
		const data: unknown = base.image.data;
		if (!(data instanceof Uint16Array)) throw new Error('the lightmap is not half floats');
		// Indexed joints first, then pairs, then lamps.
		const lists = jointLists([...joints, ...pairs, ...lamps]);
		const n = lists.texels.length;
		// The lists put the texels a joint or pair changes first: as a door moves, only
		// those are drawn again.
		const seen = new Set<number>();
		for (const j of [...joints, ...pairs]) for (const t of j.texels) seen.add(t);
		this.jointTexels = seen.size;
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
		this.lampKeys = lamps.map((l) => l.key);
		this.open = { value: joints.map(() => 0) };
		this.lamps = { value: lamps.map(() => new THREE.Vector3()) };
		this.pairs = pairs.map((p) => {
			const { joint, lamp } = pairOf(p.key);
			const j = this.keys.indexOf(joint);
			const l = this.lampKeys.indexOf(lamp);
			if (j < 0 || l < 0) throw new Error(`the pair ${p.key} has no joint or lamp`);
			return { joint: j, lamp: l };
		});
		this.pairWeights = { value: pairs.map(() => new THREE.Vector3()) };
		const material = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			defines: {
				JOINTS: joints.length,
				PAIRS: pairs.length,
				JOINT_SLOTS: Math.max(1, joints.length),
				PAIR_SLOTS: Math.max(1, pairs.length),
				LAMP_SLOTS: Math.max(1, lamps.length),
				LIST_ROW,
			},
			uniforms: {
				open: this.open,
				lamps: this.lamps,
				pairs: this.pairWeights,
				pairJoint: { value: this.pairs.map((p) => p.joint) },
				pairLamp: { value: this.pairs.map((p) => p.lamp) },
				casting: this.casting,
				daylight: this.daylight,
				list: { value: list },
			},
			blending: THREE.NoBlending,
			vertexShader: /* glsl */ `
				uniform float open[JOINT_SLOTS];
				uniform vec3 lamps[LAMP_SLOTS];
				uniform vec3 pairs[PAIR_SLOTS];
				uniform float pairJoint[PAIR_SLOTS];
				uniform float pairLamp[PAIR_SLOTS];
				uniform int casting;
				uniform float daylight;
				uniform highp sampler2D list;
				in vec3 shut;
				in float first;
				in float count;
				in float owner;
				out vec3 vLight;
				out float vCast;
				void main() {
					vec3 day = shut;
					vec3 lamp = vec3(0.0);
					// The casting lamp's part of it.
					vec3 castLight = vec3(0.0);
					int at = int(first);
					for (int i = 0; i < int(count); i++, at++) {
						vec4 e = texelFetch(list, ivec2(at % LIST_ROW, at / LIST_ROW), 0);
						int k = int(e.x);
						if (k >= JOINTS + PAIRS) {
							vec3 its = lamps[k - JOINTS - PAIRS] * e.yzw;
							lamp += its;
							if (k - JOINTS - PAIRS == casting) castLight += its;
							continue;
						}
						// Its joint: another joint's change, on a part this texel's joint moves,
						// counts as far as that part is still shut: it was baked with it shut.
						int j = k < JOINTS ? k : int(pairJoint[k - JOINTS]);
						float shut = owner >= 0.0 && int(owner) != j ? 1.0 - open[int(owner)] : 1.0;
						if (k < JOINTS) day += shut * open[k] * e.yzw;
						else {
							vec3 its = shut * pairs[k - JOINTS] * e.yzw;
							lamp += its;
							if (int(pairLamp[k - JOINTS]) == casting) castLight += its;
						}
					}
					vec3 light = daylight * max(day, vec3(0.0)) + max(lamp, vec3(0.0));
					vLight = max(light, vec3(0.0));
					const vec3 luma = vec3(0.2126, 0.7152, 0.0722);
					vCast = clamp(dot(max(castLight, vec3(0.0)), luma) / max(dot(vLight, luma), 1e-6), 0.0, 1.0);
					gl_PointSize = 1.0;
					gl_Position = vec4(position.xy, 0.0, 1.0);
				}
			`,
			fragmentShader: /* glsl */ `
				in vec3 vLight;
				in float vCast;
				out vec4 outColor;
				// Its alpha: the share of its light the casting lamp gave (MovingShadow).
				void main() { outColor = vec4(vLight, vCast); }
			`,
		});
		const mesh = new THREE.Points(g, material);
		mesh.frustumCulled = false;
		this.points.add(mesh);
		this.cloud = mesh;
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

	/** Shows each joint `openness(key)` of the way open (0 shut, 1 as baked), each
	 *  lamp at its `weight(key)` (RGB, 0 off) and the daylight (1 day, 0 night),
	 *  with the share of `casting`'s light (the lamp the moving things' shadows are
	 *  cast from) in the alpha; true if the light changed. */
	show(
		openness: (key: string) => number,
		weight: (key: string) => [number, number, number],
		daylight: number,
		casting?: string,
	): boolean {
		const open = this.keys.map((k) => openness(k));
		const lamps = this.lampKeys.map((k) => new THREE.Vector3(...weight(k)));
		const cast = casting === undefined ? -1 : this.lampKeys.indexOf(casting);
		const dark = daylight !== this.daylight.value;
		const recast = cast !== this.casting.value;
		this.casting.value = cast;
		if (
			!dark &&
			!recast &&
			open.every((v, k) => v === this.open.value[k]) &&
			lamps.every((v, k) => v.equals(this.lamps.value[k]))
		)
			return false;
		const lit = dark || recast || lamps.some((v, k) => !v.equals(this.lamps.value[k]));
		this.open.value = open;
		this.lamps.value = lamps;
		this.pairWeights.value = this.pairs.map((p) =>
			lamps[p.lamp].clone().multiplyScalar(open[p.joint]),
		);
		this.daylight.value = daylight;
		if (dark) this.draw(this.copy);
		this.cloud.geometry.setDrawRange(0, lit ? Infinity : this.jointTexels);
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
 * the shader. Returns what to dispose of, and `recapture`, which captures every
 * probe again: after the light changes (a lamp, the evening).
 */
export function addReflections(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	lit: Lit,
	/** The lamps' light in rooms they are not in: a room's copies read it too. */
	far?: ProbeLight,
	/** The moving things' shadows, which take the casting lamp's light off. */
	shadow?: MovingShadow,
): { owned: { dispose(): void }[]; recapture: () => void } {
	const owned: { dispose(): void }[] = [];
	const byRoom = new Map<string, THREE.Mesh[]>();
	for (const mesh of lit.meshes) {
		const room = String(mesh.userData['room']);
		byRoom.set(room, [...(byRoom.get(room) ?? []), mesh]);
	}
	// Every probe is captured before any surface reflects: none sees another's reflections.
	const cameras = new Map<string, THREE.CubeCamera>();
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
		owned.push(cube);
		cameras.set(room, camera);
	}
	const probes = new Map<string, THREE.WebGLRenderTarget>();
	const capture = () => {
		const pmrem = new THREE.PMREMGenerator(renderer);
		for (const [room, camera] of cameras) {
			camera.update(renderer, scene);
			probes.get(room)?.dispose();
			probes.set(room, pmrem.fromCubemap(camera.renderTarget.texture));
		}
		pmrem.dispose();
	};
	capture();

	const specularOnly = specularOnlyChunk();
	// The first room to use a material keeps it; each other room gets a copy.
	const firstRoom = new Map<THREE.Material, string>();
	const copies = new Map<string, THREE.MeshStandardMaterial>();
	const done = new Set<THREE.Material>();
	const reflecting: [THREE.MeshStandardMaterial, string][] = [];
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
			own.envMap = probes.get(room)?.texture ?? null;
			reflecting.push([own, room]);
			own.envMapIntensity = 1;
			const lampProbes = far?.has(room) ? far.uniforms(room) : undefined;
			own.onBeforeCompile = (shader) => {
				shader.fragmentShader = shader.fragmentShader.replace(
					'#include <lights_fragment_maps>',
					specularOnly,
				);
				if (far && lampProbes) far.patch(shader, lampProbes, 'lightmap');
				// After the far light: the shadow takes off the lightmap's light alone.
				shadow?.patch(shader);
			};
			// A room with far light draws with a program of its own.
			own.customProgramCacheKey = () => (lampProbes ? 'far' : 'near') + (shadow ? ' shaded' : '');
			own.needsUpdate = true;
		}
	return {
		owned: [...owned, { dispose: () => probes.forEach((p) => p.dispose()) }],
		recapture: () => {
			capture();
			for (const [m, room] of reflecting) m.envMap = probes.get(room)?.texture ?? null;
		},
	};
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
