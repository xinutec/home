import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { type GpuExposure, easeExposure } from './exposure';

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
	/** Whether it still settles, the view last changed `quiet` ms ago. */
	settling(quiet: number, now: number): boolean;
	/** Aims the exposure at `key` (the evening's, the day's), where it follows the
	 *  view. */
	aimExposure(key: number): void;
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

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swapIn(text: string, from: string, to: string, what: string): string {
	if (!text.includes(from)) throw new Error(`three's ${what} shader has no ${from}`);
	return text.replace(from, to);
}

/**
 * What a camera does with the light, in one pass over the frame: three's tone curve
 * (`OutputPass`), with the white balance and the exposure before it. The white
 * balance scales the frame's light so that the light filling the room comes out the
 * colour of a white light (`see`), eased as the exposure is: a warm lamp's room
 * comes out near the daylight's colour, as a phone shows it; the light is known, so
 * no colour in the view (a blue rug) is taken for it.
 */
class CameraPass extends OutputPass {
	private readonly gain = new THREE.Vector3(1, 1, 1);
	private wanted?: [number, number, number];
	private last?: number;

	/** `exposure`: the view-following one, which this pass applies, else the
	 *  renderer's fixed `toneMappingExposure` alone. */
	constructor(private readonly exposure?: GpuExposure) {
		super();
		const m = this.material;
		m.uniforms['gain'] = { value: this.gain };
		m.uniforms['exposureMap'] = { value: exposure?.texture ?? null };
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'uniform sampler2D tDiffuse;',
			`uniform sampler2D tDiffuse;\nuniform vec3 gain;${exposure ? '\nuniform sampler2D exposureMap;' : ''}`,
			'output',
		);
		m.fragmentShader = swapIn(
			m.fragmentShader,
			'gl_FragColor = texture2D( tDiffuse, vUv );',
			`gl_FragColor = texture2D( tDiffuse, vUv );
			gl_FragColor.rgb *= gain${exposure ? ' * texture2D( exposureMap, vec2( 0.5 ) ).r' : ''};`,
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
		this.exposure?.update(renderer, readBuffer.texture, now);
		if (this.exposure) this.material.uniforms['exposureMap'].value = this.exposure.texture;
		super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
	}
}

/**
 * The image as a camera makes it from the room's light: the room drawn into a
 * buffer that keeps light past white (half floats), then darkened where things
 * meet (ground-truth ambient occlusion, GTAO, on the screen, by who may darken
 * whom: `ReceiverGTAOPass`), then white balanced, exposed and put through the tone
 * curve, in one pass
 * (`CameraPass`), then its edges smoothed (SMAA).
 */
export function imageStage(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	camera: THREE.PerspectiveCamera,
	width: number,
	height: number,
	/** The exposure following the view, unless it is fixed (`?exposure`). */
	exposure?: GpuExposure,
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
	const lens = new CameraPass(exposure);
	composer.addPass(lens);
	// Edges smoothed in the finished image, after the tone curve: smoothed before it
	// (multisampling the buffer), a sliver of window or sky in an edge, its light
	// tens of times a wall's, makes the whole pixel white.
	composer.addPass(new SMAAPass());
	return {
		composer,
		balance: (light, white) => lens.see(light, white),
		settling: (quiet, now) => lens.settling || !!exposure?.settling(quiet, now),
		aimExposure: (key) => exposure?.aim(key),
	};
}
