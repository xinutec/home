import * as THREE from 'three';
import { MOVES_LAYER } from './image-stage';

/** Texels across the shadow map: a room 4 m across under a lamp at 120° gets a
 *  texel every centimetre or so at the floor. */
const SIZE = 1024;
/** The map's field of view, straight down from a ceiling lamp: a room's corners
 *  are about 50° off its axis. */
const FOV = 120;
/** Taps a pixel looks for what blocks the light with, and filters its shadow by. */
const TAPS = 16;
/** The most patches a light's glowing part is summed into (`glowPatches`). */
export const MAX_PATCHES = 26;

/** A light the shadow is cast from: where its glowing part is, its radius, the
 *  part as patches (`glowPatches`), and its radiance now (RGB, the bake's units). */
export interface ShadowSource {
	at: THREE.Vector3;
	radius: number;
	patches: GlowPatch[];
	radiance: [number, number, number];
}

/** Part of a glowing surface: its middle, and its vector area (its facing times its
 *  area, summed over its triangles). */
export interface GlowPatch {
	at: THREE.Vector3;
	area: THREE.Vector3;
}

/** The facings a glowing surface's triangles are summed by: toward a cube's faces,
 *  edges and corners, MAX_PATCHES of them. */
const FACINGS = [-1, 0, 1]
	.flatMap((x) => [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((z) => [x, y, z])))
	.filter(([x, y, z]) => x !== 0 || y !== 0 || z !== 0)
	.map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());

/**
 * A glowing surface (the meshes' outer faces, in the room) as at most MAX_PATCHES
 * patches: its triangles summed by the facing nearest theirs, each patch at their
 * area-weighted middle with their summed vector area. A vector area gives the
 * surface's projected area seen from any way exactly, so the light a point gets
 * from it is right wherever the point is far beside the patches' size.
 */
export function glowPatches(meshes: THREE.Mesh[]): GlowPatch[] {
	const sums = FACINGS.map(() => ({
		at: new THREE.Vector3(),
		area: new THREE.Vector3(),
		weight: 0,
	}));
	const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
	const n = new THREE.Vector3();
	for (const mesh of meshes) {
		mesh.updateMatrixWorld();
		const p = mesh.geometry.getAttribute('position');
		const index = mesh.geometry.index;
		const count = index ? index.count : p.count;
		const at = (i: number, v: THREE.Vector3) =>
			v.fromBufferAttribute(p, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
		for (let i = 0; i + 2 < count; i += 3) {
			at(i, a);
			at(i + 1, b);
			at(i + 2, c);
			// Half the cross product: the triangle's vector area.
			n.subVectors(b, a).cross(c.clone().sub(a)).multiplyScalar(0.5);
			const area = n.length();
			if (area === 0) continue;
			let best = 0;
			FACINGS.forEach((f, k) => {
				if (f.dot(n) > FACINGS[best].dot(n)) best = k;
			});
			const s = sums[best];
			s.area.add(n);
			s.at.addScaledVector(a.clone().add(b).add(c), area / 3);
			s.weight += area;
		}
	}
	return sums
		.filter((s) => s.weight > 0)
		.map((s) => ({ at: s.at.divideScalar(s.weight), area: s.area }));
}

/**
 * The shadows of the things that move, cast from one light (the lamp lighting the
 * view most), onto the room's surfaces. A depth map of the moving things alone,
 * from the light (`MOVES_LAYER`); a room surface in it takes away the share of its
 * baked light that came from that light (`LiveLight`'s lightmap alpha), softened by
 * the light's size: contact sharp, further off wider (percentage-closer soft
 * shadows: the blockers found near the pixel, the penumbra from how far they are
 * from it and from the light). Only moving things are in the map, so no room
 * surface shades itself.
 */
export class MovingShadow {
	private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 10);
	private readonly depth = new THREE.DepthTexture(SIZE, SIZE);
	private readonly target: THREE.WebGLRenderTarget;
	private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
	/** Whether the map is out of date for the light (aimed since it was drawn). */
	private stale = true;
	readonly uniforms = {
		movingShadowMap: { value: this.depth },
		/** From the room to the map's clip space. */
		movingShadowMatrix: { value: new THREE.Matrix4() },
		/** From the room to the light's view (its depth along -z). */
		movingShadowView: { value: new THREE.Matrix4() },
		movingShadowNearFar: { value: new THREE.Vector2(this.camera.near, this.camera.far) },
		/** The light's radius, and the map's half-width at a metre (tan of half its view). */
		movingShadowLight: { value: new THREE.Vector2() },
		/** 1 while a light casts, else 0: no shadow, nothing sampled. */
		movingShadowOn: { value: 0 },
		/** Where in the map a shadow can fall (u, v from; u, v to): the moving things'
		 *  outline there, widened by the softest penumbra. A pixel outside it is lit
		 *  without a look in the map. */
		movingShadowRect: { value: new THREE.Vector4(2, 2, -1, -1) },
		/** The light's patches (`glowPatches`): middles, vector areas, how many. */
		movingPatchAt: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector3()) },
		movingPatchArea: { value: Array.from({ length: MAX_PATCHES }, () => new THREE.Vector3()) },
		movingPatches: { value: 0 },
		movingRadiance: { value: new THREE.Vector3() },
	};

	constructor() {
		this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture: this.depth });
		this.camera.layers.set(MOVES_LAYER);
		// It looks straight down: up, as the map sees it, is along the room's z.
		this.camera.up.set(0, 0, 1);
		this.uniforms.movingShadowLight.value.y = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
	}

	/** Casts from `source` from now on, or from nothing. */
	aim(source: ShadowSource | undefined): void {
		this.uniforms.movingShadowOn.value = source ? 1 : 0;
		this.stale = true;
		if (!source) return;
		this.camera.position.copy(source.at);
		this.camera.lookAt(source.at.x, source.at.y - 1, source.at.z);
		this.camera.updateMatrixWorld();
		this.uniforms.movingShadowView.value.copy(this.camera.matrixWorldInverse);
		this.uniforms.movingShadowMatrix.value.multiplyMatrices(
			this.camera.projectionMatrix,
			this.camera.matrixWorldInverse,
		);
		this.uniforms.movingShadowLight.value.x = source.radius;
		if (source.patches.length > MAX_PATCHES)
			throw new Error(`a light of ${source.patches.length} patches: MAX_PATCHES is ${MAX_PATCHES}`);
		source.patches.forEach((p, i) => {
			this.uniforms.movingPatchAt.value[i].copy(p.at);
			this.uniforms.movingPatchArea.value[i].copy(p.area);
		});
		this.uniforms.movingPatches.value = source.patches.length;
		this.uniforms.movingRadiance.value.set(...source.radiance);
	}

	/** Draws the map from where the moving things are now (their boxes in the room,
	 *  `casters`, asked only then) if they `moved` or the light did; nothing while none casts. Most
	 *  frames nothing moves: the map stands. */
	render(
		renderer: THREE.WebGLRenderer,
		scene: THREE.Scene,
		casters: () => THREE.Box3[],
		moved: boolean,
	): void {
		if (this.uniforms.movingShadowOn.value === 0 || !(moved || this.stale)) return;
		this.stale = false;
		this.uniforms.movingShadowRect.value.copy(this.shadowRect(casters()));
		const [before, background, override] = [
			renderer.getRenderTarget(),
			scene.background,
			scene.overrideMaterial,
		];
		scene.background = null;
		scene.overrideMaterial = this.depthOnly;
		renderer.setRenderTarget(this.target);
		renderer.clear();
		renderer.render(scene, this.camera);
		renderer.setRenderTarget(before);
		scene.background = background;
		scene.overrideMaterial = override;
	}

	/** Makes a room material (`onBeforeCompile`'s `shader`, its lights chunk already
	 *  in) take the shadow off its lightmap's light: by the lightmap's alpha, the
	 *  share of it the casting light gave. */
	patch(shader: THREE.WebGLProgramParametersWithUniforms): void {
		Object.assign(shader.uniforms, this.uniforms);
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <common>',
			'#include <common>\nvarying vec3 vShadowAt;',
		);
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <project_vertex>',
			'#include <project_vertex>\nvShadowAt = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'#include <common>',
			`#include <common>
			varying vec3 vShadowAt;
			uniform highp sampler2D movingShadowMap;
			uniform mat4 movingShadowMatrix;
			uniform mat4 movingShadowView;
			uniform vec2 movingShadowNearFar;
			uniform vec2 movingShadowLight;
			uniform float movingShadowOn;
			uniform vec4 movingShadowRect;
			uniform vec3 movingPatchAt[${MAX_PATCHES}];
			uniform vec3 movingPatchArea[${MAX_PATCHES}];
			uniform int movingPatches;
			uniform vec3 movingRadiance;
			// The light's direct irradiance at a point facing n (the room's): each patch's
			// radiance times its projected area and the point's cosine, over the distance
			// squared.
			vec3 movingDirect(vec3 at, vec3 n) {
				float sum = 0.0;
				for (int i = 0; i < ${MAX_PATCHES}; i++) {
					if (i >= movingPatches) break;
					vec3 d = at - movingPatchAt[i];
					float d2 = max(dot(d, d), 1e-4);
					vec3 w = d * inversesqrt(d2);
					sum += max(dot(movingPatchArea[i], w), 0.0) * max(dot(n, -w), 0.0) / d2;
				}
				return movingRadiance * sum;
			}
			// Its depth in the map, as metres from the light.
			float shadowDistance(vec2 uv) {
				float z = texture2D(movingShadowMap, uv).x;
				float n = movingShadowNearFar.x, f = movingShadowNearFar.y;
				return n * f / (f - z * (f - n));
			}
			// A tap's offset, in a disc: a golden-angle spiral.
			vec2 shadowTap(int i) {
				float r = sqrt((float(i) + 0.5) / ${TAPS}.0);
				float a = float(i) * 2.39996323;
				return r * vec2(cos(a), sin(a));
			}
			// How much of the casting light reaches the point: 1 all, 0 none.
			float movingLight(vec3 at) {
				if (movingShadowOn < 0.5) return 1.0;
				vec4 clip = movingShadowMatrix * vec4(at, 1.0);
				if (clip.w <= 0.0) return 1.0;
				vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
				if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
				// Where no moving thing can shade: lit, without a look in the map.
				if (any(lessThan(uv, movingShadowRect.xy)) || any(greaterThan(uv, movingShadowRect.zw))) return 1.0;
				float here = -(movingShadowView * vec4(at, 1.0)).z;
				// The map's width, in metres, at this pixel's distance.
				float wide = 2.0 * here * movingShadowLight.y;
				// What blocks the light, near enough to shade here: within the light's size.
				float search = movingShadowLight.x / wide;
				float blockers = 0.0, found = 0.0;
				for (int i = 0; i < ${TAPS}; i++) {
					float d = shadowDistance(uv + shadowTap(i) * search);
					if (d < here - 0.01) { blockers += d; found += 1.0; }
				}
				if (found == 0.0) return 1.0;
				float blocker = blockers / found;
				// The penumbra's width, from the light's size and how far the blocker is
				// from the light and from here; at least a texel.
				float penumbra = max(movingShadowLight.x * (here - blocker) / blocker / wide, 1.0 / ${SIZE}.0);
				float lit = 0.0;
				for (int i = 0; i < ${TAPS}; i++)
					lit += shadowDistance(uv + shadowTap(i) * penumbra) < here - 0.01 ? 0.0 : 1.0;
				return lit / ${TAPS}.0;
			}
			// The lightmap's light at this pixel with the moving things' shadow taken off.
			vec3 movingShaded(vec3 light, float share, vec3 n) {
				if (share <= 0.0 || movingShadowOn < 0.5) return light;
				float hidden = 1.0 - movingLight(vShadowAt);
				if (hidden <= 0.0) return light;
				return light - hidden * min(movingDirect(vShadowAt, n), share * light);
			}`,
		);
		// The shadow takes the light's direct light, no more than all it gave here (the
		// lightmap's alpha, its share); what it sends round the room still comes.
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity',
			`vec3 lightMapIrradiance = movingShaded(
				lightMapTexel.rgb * lightMapIntensity,
				lightMapTexel.a,
				inverseTransformDirection(geometryNormal, viewMatrix))`,
		);
	}

	/** Where the `casters` (boxes in the room) can shade in the map, as u, v from and
	 *  to: their corners as the light sees them, widened by the widest penumbra one
	 *  makes (the light's radius over its nearest distance from the light, as the map
	 *  measures it: the penumbra's width a blocker that near throws, at most). */
	private shadowRect(casters: THREE.Box3[]): THREE.Vector4 {
		const rect = new THREE.Vector4(2, 2, -1, -1);
		const toMap = this.uniforms.movingShadowMatrix.value;
		const view = this.uniforms.movingShadowView.value;
		const p = new THREE.Vector4();
		let nearest = Infinity;
		for (const box of casters)
			for (let k = 0; k < 8; k++) {
				const corner = new THREE.Vector3(
					k & 1 ? box.max.x : box.min.x,
					k & 2 ? box.max.y : box.min.y,
					k & 4 ? box.max.z : box.min.z,
				);
				// Above the light, or beside it: anywhere in the map, to be safe.
				if (-corner.clone().applyMatrix4(view).z <= this.camera.near)
					return new THREE.Vector4(0, 0, 1, 1);
				nearest = Math.min(nearest, -corner.clone().applyMatrix4(view).z);
				p.set(corner.x, corner.y, corner.z, 1).applyMatrix4(toMap);
				const [u, v] = [(p.x / p.w) * 0.5 + 0.5, (p.y / p.w) * 0.5 + 0.5];
				rect.set(
					Math.min(rect.x, u),
					Math.min(rect.y, v),
					Math.max(rect.z, u),
					Math.max(rect.w, v),
				);
			}
		if (nearest === Infinity) return rect;
		const [radius, halfTan] = [
			this.uniforms.movingShadowLight.value.x,
			this.uniforms.movingShadowLight.value.y,
		];
		const margin = radius / (2 * nearest * halfTan);
		return rect.set(rect.x - margin, rect.y - margin, rect.z + margin, rect.w + margin);
	}

	dispose(): void {
		this.target.dispose();
		this.depth.dispose();
		this.depthOnly.dispose();
	}
}

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swap(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`three's shader has no ${from}: no moving shadows`);
	return text.replace(from, to);
}
