import * as THREE from 'three';

/** Things that can shade others at once: a uniform array's length, well inside a
 *  phone's fragment uniforms (a matrix each). */
export const MAX_OCCLUDERS = 16;
/** Of the light a thing blocks, the share it takes away: the rest it reflects back
 *  (a pale cushion lights what it shades), as the contact shadow's DARKNESS. */
const STRENGTH = 0.85;
/** Radii from its middle at which a thing's shade starts to fade, and is gone: each
 *  pixel then pays only for the things near it. At 2 radii a sphere still takes a
 *  quarter of the light from a surface facing it, so it fades, not stops. */
const FADE = 2;
const REACH = 3;

/**
 * The things that move, each as an ellipsoid that shades what is near it, as games
 * shade with capsules or spheres where a baked light cannot know where a thing is.
 * A surface's light from all round is cut by the share of its sky the ellipsoid
 * covers, in closed form: the exact occlusion of a sphere (Quilez; Lagarde and de
 * Rousiers), in a space where the ellipsoid is the unit sphere. No bake, and drawn
 * as the thing moves. Each is one matrix: from the room into that space, its
 * bottom row the radii squared, by which a facing is carried there.
 */
export class Occluders {
	readonly uniforms = {
		occluders: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Matrix4()) },
		occluderCount: { value: 0 },
		/** 1 while they shade (by day), 0 while not (evening: the lamps cast shadows). */
		occludersOn: { value: 1 },
	};

	/** Shades by day, not in the evening, when the lamps cast the things' shadows. */
	set on(on: boolean) {
		this.uniforms.occludersOn.value = on ? 1 : 0;
	}

	/** Takes a slot for a thing: its index. */
	add(): number {
		const i = this.uniforms.occluderCount.value;
		if (i >= MAX_OCCLUDERS)
			throw new Error(`more than ${MAX_OCCLUDERS} things move in one view: raise MAX_OCCLUDERS`);
		this.uniforms.occluderCount.value = i + 1;
		return i;
	}

	/** Places slot `i`: an ellipsoid of half-axes `radii` round `middle`, both in the
	 *  frame of `world` (a thing's matrix in the room). */
	place(i: number, world: THREE.Matrix4, middle: THREE.Vector3, radii: THREE.Vector3): void {
		const m = this.uniforms.occluders.value[i];
		m.copy(world)
			.multiply(new THREE.Matrix4().makeTranslation(middle))
			.multiply(new THREE.Matrix4().makeScale(radii.x, radii.y, radii.z))
			.invert();
		// The bottom row, (0, 0, 0, 1) in an affine matrix, carries the radii squared.
		const e = m.elements;
		[e[3], e[7], e[11]] = [radii.x ** 2, radii.y ** 2, radii.z ** 2];
	}

	/**
	 * Makes a material's light from all round (`onBeforeCompile`'s `shader`) shaded
	 * by the things: a thing's own parts by the others (`self`, its slot), a room's
	 * surface by all.
	 */
	patch(
		shader: THREE.WebGLProgramParametersWithUniforms,
		receiver: { self: number } | 'surface',
	): void {
		shader.uniforms['occluders'] = this.uniforms.occluders;
		shader.uniforms['occluderCount'] = this.uniforms.occluderCount;
		shader.uniforms['occludersOn'] = this.uniforms.occludersOn;
		// A uniform, not written into the code: every thing's parts share one program.
		shader.uniforms['occluderSelf'] = { value: receiver === 'surface' ? -1 : receiver.self };
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <common>',
			'#include <common>\nvarying vec3 vOccludedAt;',
		);
		shader.vertexShader = swap(
			shader.vertexShader,
			'#include <project_vertex>',
			'#include <project_vertex>\nvOccludedAt = (modelMatrix * vec4(transformed, 1.0)).xyz;',
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'#include <common>',
			`#include <common>
			varying vec3 vOccludedAt;
			uniform mat4 occluders[${MAX_OCCLUDERS}];
			uniform int occluderCount;
			uniform int occluderSelf;
			uniform float occludersOn;
			// The share of the light from all round a surface at p facing n loses to the
			// unit sphere at the origin: exact, the sphere above, below or across its horizon.
			float sphereOcclusion(vec3 p, vec3 n) {
				float l = max(length(p), 1.0001);
				float nl = dot(n, -p / l);
				float h2 = l * l;
				float k2 = 1.0 - h2 * nl * nl;
				float res = max(0.0, nl) / h2;
				if (k2 > 0.001) {
					res = nl * acos(-nl * sqrt((h2 - 1.0) / (1.0 - nl * nl))) - sqrt(k2 * (h2 - 1.0));
					res = res / h2 + atan(sqrt(k2 / (h2 - 1.0)));
					res /= PI;
				}
				return clamp(res, 0.0, 1.0);
			}
			// The share of its light from all round a surface at p (room) facing n keeps.
			float thingsLeave(vec3 p, vec3 n) {
				if (occludersOn < 0.5) return 1.0;
				float left = 1.0;
				for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
					if (i >= occluderCount) break;
					if (i == occluderSelf) continue;
					mat4 m = occluders[i];
					vec3 q = mat3(m) * p + m[3].xyz;
					float h2 = dot(q, q);
					if (h2 >= ${(REACH ** 2).toFixed(1)}) continue;
					vec3 r2 = vec3(m[0][3], m[1][3], m[2][3]);
					vec3 f = normalize(r2 * (mat3(m) * n));
					float fade = 1.0 - smoothstep(${(FADE ** 2).toFixed(1)}, ${(REACH ** 2).toFixed(1)}, h2);
					float cut = fade * sphereOcclusion(q, f);
					left *= 1.0 - ${STRENGTH.toFixed(3)} * cut;
				}
				return left;
			}`,
		);
		shader.fragmentShader = swap(
			shader.fragmentShader,
			'#include <aomap_fragment>',
			`#include <aomap_fragment>
			{
				float left = thingsLeave(vOccludedAt, inverseTransformDirection(normal, viewMatrix));
				reflectedLight.indirectDiffuse *= left;
				reflectedLight.indirectSpecular *= left;
			}`,
		);
	}
}

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swap(text: string, from: string, to: string): string {
	if (!text.includes(from))
		throw new Error(`three's shader has no ${from}: things would not shade each other`);
	return text.replace(from, to);
}
