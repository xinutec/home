import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { easeExposure } from './exposure';

/** The layer the things that move are drawn on as well (`Movables`): the occlusion
 *  pass draws them alone by it. */
export const MOVES_LAYER = 1;
/** Metres round a point that its occlusion is looked for in: a cushion's reach on
 *  the sofa it leans on, a jar's on the wall behind it. */
const AO_RADIUS = 0.3;
/** How far in front of a surface, along the view, a thing still counts as touching
 *  what it covers: three's 1 m darkens a wall round a jar's outline that stands
 *  well clear of it. */
const AO_THICKNESS = 0.1;
/** How much of the light occlusion takes away (0 none, 1 all). */
const AO_STRENGTH = 1;
/** How strongly occlusion is found: three's 1 leaves a cushion standing on a seat
 *  barely darker at its foot, where it covers half the sky. */
const AO_SCALE_UP = 2;
/** The share of the screen's width and height occlusion is found at: it is soft
 *  (a crease's shade spreads centimetres), so half, a quarter of the pixels. */
const AO_SCALE = 0.5;
/** Samples a pixel's occlusion is found from, and its noise smoothed by. */
const AO_SAMPLES = 16;
const DENOISE_SAMPLES = 16;

/** The image stage: what draws each frame, and whether it still settles (another
 *  frame should follow). */
export interface ImageStage {
	composer: EffectComposer;
	/** White balances `light` (linear RGB), the light filling the room the eye is
	 *  in, to the colour of `white` (that room's daylight, which the paints were
	 *  fitted under, as the phone balanced it), eased as the exposure is. */
	balance(light: [number, number, number], white: [number, number, number]): void;
	settling(): boolean;
}

/** The gains, red, green and blue, that make `light` (linear RGB) the colour of
 *  `white`, keeping its luminance: a camera's white balance for it. No light, or no
 *  white, nothing to balance: 1. */
export function balanceFor(
	light: [number, number, number],
	white: [number, number, number],
): [number, number, number] {
	const y = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
	if (y(light) <= 0 || y(white) <= 0) return [1, 1, 1];
	const k = y(light) / y(white);
	return [(k * white[0]) / light[0], (k * white[1]) / light[1], (k * white[2]) / light[2]];
}

/**
 * GTAO at AO_SCALE of the screen, where who may darken a pixel depends on what it
 * is. The room's surfaces have their creases and corners in the bake already: only
 * things that move darken them, read from a depth buffer of those alone. A thing
 * that moves is lit from the probes, which know nothing near it: everything darkens
 * it. A pixel is a moving thing's where both depth buffers hold the same depth.
 */
class ReceiverGTAOPass extends GTAOPass {
	private readonly moving: THREE.WebGLRenderTarget;
	private readonly movingDepth = new THREE.DepthTexture(1, 1);
	private readonly depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });

	constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
		super(scene, camera, width, height);
		// As three's own depth for GTAO, so that the two compare exactly.
		this.movingDepth.format = THREE.DepthStencilFormat;
		this.movingDepth.type = THREE.UnsignedInt248Type;
		this.moving = new THREE.WebGLRenderTarget(1, 1, {
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			depthTexture: this.movingDepth,
		});
		const m = this.gtaoMaterial;
		m.uniforms['tMovingDepth'] = { value: this.movingDepth };
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'#include <common>',
			`#include <common>
			uniform highp sampler2D tMovingDepth;
			// Whether this pixel is a moving thing's, so that everything darkens it.
			bool receiverMoves;`,
			'GTAO',
		);
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'float sampleSceneDepth = getDepth(sampleUv);',
			`float sampleSceneDepth = receiverMoves
				? getDepth(sampleUv)
				: textureLod(tMovingDepth, sampleUv, 0.0).x;`,
			'GTAO',
		);
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'float depth = getDepth(vUv.xy);',
			`float depth = getDepth(vUv.xy);
			receiverMoves = abs(textureLod(tMovingDepth, vUv, 0.0).x - depth) < 1e-6;`,
			'GTAO',
		);
		this.setSize(width, height);
	}

	override setSize(width: number, height: number): void {
		const [w, h] = [
			Math.max(1, Math.round(width * AO_SCALE)),
			Math.max(1, Math.round(height * AO_SCALE)),
		];
		super.setSize(w, h);
		this.moving.setSize(w, h);
	}

	override render(
		renderer: THREE.WebGLRenderer,
		writeBuffer: THREE.WebGLRenderTarget,
		readBuffer: THREE.WebGLRenderTarget,
		deltaTime: number,
		maskActive: boolean,
	): void {
		// The things that move alone, their depth only.
		const [layers, background, override] = [
			this.camera.layers.mask,
			this.scene.background,
			this.scene.overrideMaterial,
		];
		this.camera.layers.set(MOVES_LAYER);
		this.scene.background = null;
		this.scene.overrideMaterial = this.depthOnly;
		renderer.setRenderTarget(this.moving);
		renderer.clear();
		renderer.render(this.scene, this.camera);
		this.camera.layers.mask = layers;
		this.scene.background = background;
		this.scene.overrideMaterial = override;
		super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
	}

	override dispose(): void {
		super.dispose();
		this.moving.dispose();
		this.movingDepth.dispose();
		this.depthOnly.dispose();
	}
}

/** The share of the light a lens and the eye scatter round it (its point spread):
 *  the image is mixed this far toward its blur, so no light is added or taken.
 *  Jimenez's (Call of Duty: Advanced Warfare, SIGGRAPH 2014). */
const BLOOM_STRENGTH = 0.04;
/** Levels the blur is built from, each a quarter the last's width (a pass each,
 *  and on a phone each pass costs for itself, however small): the widest, at 1/64
 *  of the screen, spreads a window's glow a tenth of the view. */
const BLOOM_LEVELS = 3;

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swapIn(text: string, from: string, to: string, what: string): string {
	if (!text.includes(from)) throw new Error(`three's ${what} shader has no ${from}`);
	return text.replace(from, to);
}

/**
 * What a camera does with the light, in one pass over the frame (three's tone curve
 * and exposure, `OutputPass`, with two steps put before them):
 *
 * - White balance: the frame's light scaled so that the light filling the room
 *   comes out the colour of a white light (`see`), eased toward it as the exposure
 *   is. A warm lamp's room comes out near the daylight's colour, as a phone shows
 *   it; the light is known, so no colour in the view (a blue rug) is taken for it.
 * - Bloom, as a lens scatters light: the frame quartered in width BLOOM_LEVELS
 *   times (the first weighted against single bright pixels so a lamp's glint does
 *   not flicker), each level added back up into the one above it through a tent
 *   filter, and the frame mixed BLOOM_STRENGTH toward the sum. Every pixel
 *   scatters; only the brightest (windows, lamps) scatter enough to see.
 */
class CameraPass extends OutputPass {
	private readonly gain = new THREE.Vector3(1, 1, 1);
	private wanted?: [number, number, number];
	private last?: number;
	private readonly levels: THREE.WebGLRenderTarget[] = [];
	/** A texel of the level each step reads. */
	private readonly downTexel = new THREE.Vector2();
	private readonly upTexel = new THREE.Vector2();
	private readonly down = new FullScreenQuad(
		new THREE.ShaderMaterial({
			uniforms: {
				tDiffuse: { value: null },
				texel: { value: this.downTexel },
				first: { value: 0 },
			},
			vertexShader: QUAD_VERTEX,
			fragmentShader: `
				uniform sampler2D tDiffuse;
				uniform vec2 texel;
				uniform float first;
				varying vec2 vUv;
				vec3 at(float x, float y) { return texture2D(tDiffuse, vUv + texel * vec2(x, y)).rgb; }
				// A tap's weight: on the first level, less the brighter it is (Karis).
				float w(vec3 c) { return first > 0.5 ? 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))) : 1.0; }
				void main() {
					// Four taps, each between four texels: the 4 × 4 texels this pixel covers.
					vec3 a = at(-1.0, -1.0), b = at(1.0, -1.0), c = at(-1.0, 1.0), d = at(1.0, 1.0);
					float wa = w(a), wb = w(b), wc = w(c), wd = w(d);
					gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
				}`,
		}),
	);
	private readonly up = new FullScreenQuad(
		new THREE.ShaderMaterial({
			uniforms: { tDiffuse: { value: null }, texel: { value: this.upTexel } },
			vertexShader: QUAD_VERTEX,
			fragmentShader: `
				uniform sampler2D tDiffuse;
				uniform vec2 texel;
				varying vec2 vUv;
				vec3 at(float x, float y) { return texture2D(tDiffuse, vUv + texel * vec2(x, y)).rgb; }
				void main() {
					vec3 s = at(-1.0, -1.0) + at(1.0, -1.0) + at(-1.0, 1.0) + at(1.0, 1.0);
					s += 2.0 * (at(0.0, -1.0) + at(-1.0, 0.0) + at(1.0, 0.0) + at(0.0, 1.0));
					s += 4.0 * at(0.0, 0.0);
					gl_FragColor = vec4(s / 16.0, 1.0);
				}`,
			// Added onto the level above, which holds that level's own copy.
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false,
		}),
	);

	/** `bloom`: whether it scatters light (`?bloom`, while its cost on a phone is
	 *  measured: on the Mac its passes cost 4-5 ms a frame however small). */
	constructor(bloom: boolean) {
		super();
		for (let i = 0; i < (bloom ? BLOOM_LEVELS : 0); i++)
			this.levels.push(
				new THREE.WebGLRenderTarget(1, 1, {
					type: THREE.HalfFloatType,
					minFilter: THREE.LinearFilter,
					magFilter: THREE.LinearFilter,
					depthBuffer: false,
				}),
			);
		const m = this.material;
		m.uniforms['gain'] = { value: this.gain };
		const [first] = this.levels;
		if (first) m.uniforms['tBloom'] = { value: first.texture };
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'uniform sampler2D tDiffuse;',
			`uniform sampler2D tDiffuse;\nuniform vec3 gain;${first ? '\nuniform sampler2D tBloom;' : ''}`,
			'output',
		);
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'gl_FragColor = texture2D( tDiffuse, vUv );',
			first
				? `gl_FragColor = texture2D( tDiffuse, vUv );
			// The levels summed, each a whole image's light: their mean is one.
			vec3 bloom = texture2D( tBloom, vUv ).rgb / ${BLOOM_LEVELS.toFixed(1)};
			gl_FragColor.rgb = mix( gl_FragColor.rgb, bloom, ${BLOOM_STRENGTH} ) * gain;`
				: `gl_FragColor = texture2D( tDiffuse, vUv );
			gl_FragColor.rgb *= gain;`,
			'output',
		);
	}

	/** Whether the white balance still eases toward the light last seen. */
	get settling(): boolean {
		const w = this.wanted;
		return !!w && this.gain.toArray().some((g, c) => Math.abs(Math.log(w[c] / g)) > 0.01);
	}

	/** Balances `light` to the colour of `white` from now on; the first at once, as
	 *  a camera opens balanced. */
	see(light: [number, number, number], white: [number, number, number]): void {
		const first = this.wanted === undefined;
		this.wanted = balanceFor(light, white);
		if (first) this.gain.fromArray(this.wanted);
	}

	override setSize(width: number, height: number): void {
		super.setSize(width, height);
		this.levels.forEach((t, i) =>
			t.setSize(Math.max(1, width >> (2 * i + 2)), Math.max(1, height >> (2 * i + 2))),
		);
	}

	override render(
		renderer: THREE.WebGLRenderer,
		writeBuffer: THREE.WebGLRenderTarget,
		readBuffer: THREE.WebGLRenderTarget,
		deltaTime: number,
		maskActive: boolean,
	): void {
		const now = performance.now();
		const dt = this.last === undefined ? 0 : (now - this.last) / 1000;
		this.last = now;
		const w = this.wanted;
		if (w) this.gain.fromArray(this.gain.toArray().map((g, c) => easeExposure(g, w[c], dt)));
		if (!this.settling) this.last = undefined;
		if (this.levels.length > 0) this.bloom(renderer, readBuffer);
		super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
	}

	override dispose(): void {
		super.dispose();
		for (const t of this.levels) t.dispose();
		for (const q of [this.down, this.up]) {
			shaderOf(q).dispose();
			q.dispose();
		}
	}

	/** The frame's blur, summed over its levels, into the first level. */
	private bloom(renderer: THREE.WebGLRenderer, frame: THREE.WebGLRenderTarget): void {
		const down = shaderOf(this.down);
		let from = frame;
		this.levels.forEach((to, i) => {
			down.uniforms['tDiffuse'].value = from.texture;
			this.downTexel.set(1 / from.width, 1 / from.height);
			down.uniforms['first'].value = i === 0 ? 1 : 0;
			renderer.setRenderTarget(to);
			this.down.render(renderer);
			from = to;
		});
		const up = shaderOf(this.up);
		const autoClear = renderer.autoClear;
		renderer.autoClear = false;
		for (let i = this.levels.length - 1; i > 0; i--) {
			const [to, small] = [this.levels[i - 1], this.levels[i]];
			up.uniforms['tDiffuse'].value = small.texture;
			this.upTexel.set(1 / small.width, 1 / small.height);
			renderer.setRenderTarget(to);
			this.up.render(renderer);
		}
		renderer.autoClear = autoClear;
	}
}

function shaderOf(quad: FullScreenQuad): THREE.ShaderMaterial {
	const m = quad.material;
	if (!(m instanceof THREE.ShaderMaterial)) throw new Error('an image stage pass lost its shader');
	return m;
}

/** A full-screen quad's vertex shader: its corners as they are. */
const QUAD_VERTEX = `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;

/**
 * The image as a camera makes it from the room's light: the room drawn into a
 * buffer that keeps light past white (half floats), then darkened where things
 * meet (ground-truth ambient occlusion, GTAO, on the screen, by who may darken
 * whom: `ReceiverGTAOPass`), then white balanced, scattered as a lens does and put
 * through the tone curve and exposure the renderer is set to, in one pass
 * (`CameraPass`; bloom only if `bloom`), then its edges smoothed (SMAA).
 */
export function imageStage(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	camera: THREE.PerspectiveCamera,
	width: number,
	height: number,
	bloom: boolean,
): ImageStage {
	const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
	const composer = new EffectComposer(renderer, target);
	composer.addPass(new RenderPass(scene, camera));
	const ao = new ReceiverGTAOPass(scene, camera, width, height);
	ao.updateGtaoMaterial({
		radius: AO_RADIUS,
		thickness: AO_THICKNESS,
		samples: AO_SAMPLES,
		scale: AO_SCALE_UP,
	});
	ao.updatePdMaterial({ samples: DENOISE_SAMPLES });
	ao.blendIntensity = AO_STRENGTH;
	composer.addPass(ao);
	const lens = new CameraPass(bloom);
	composer.addPass(lens);
	// Edges smoothed in the finished image, after the tone curve: smoothed before it
	// (multisampling the buffer), a sliver of window or sky in an edge, its light
	// tens of times a wall's, makes the whole pixel white.
	composer.addPass(new SMAAPass());
	return {
		composer,
		balance: (light, white) => lens.see(light, white),
		settling: () => lens.settling,
	};
}
