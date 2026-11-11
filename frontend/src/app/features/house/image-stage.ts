import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

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
		m.fragmentShader = swap(
			m.fragmentShader,
			'#include <common>',
			`#include <common>
			uniform highp sampler2D tMovingDepth;
			// Whether this pixel is a moving thing's, so that everything darkens it.
			bool receiverMoves;`,
		);
		m.fragmentShader = swap(
			m.fragmentShader,
			'float sampleSceneDepth = getDepth(sampleUv);',
			`float sampleSceneDepth = receiverMoves
				? getDepth(sampleUv)
				: textureLod(tMovingDepth, sampleUv, 0.0).x;`,
		);
		m.fragmentShader = swap(
			m.fragmentShader,
			'float depth = getDepth(vUv.xy);',
			`float depth = getDepth(vUv.xy);
			receiverMoves = abs(textureLod(tMovingDepth, vUv, 0.0).x - depth) < 1e-6;`,
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

/**
 * The image as a camera makes it from the room's light: the room drawn into a
 * buffer that keeps light past white (half floats), then darkened where things
 * meet (ground-truth ambient occlusion, GTAO, on the screen, by who may darken
 * whom: `ReceiverGTAOPass`), then the tone curve and exposure the renderer is set
 * to (`OutputPass`), then its edges smoothed (SMAA).
 */
export function imageStage(
	renderer: THREE.WebGLRenderer,
	scene: THREE.Scene,
	camera: THREE.PerspectiveCamera,
	width: number,
	height: number,
): EffectComposer {
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
	composer.addPass(new OutputPass());
	// Edges smoothed in the finished image, after the tone curve: smoothed before it
	// (multisampling the buffer), a sliver of window or sky in an edge, its light
	// tens of times a wall's, makes the whole pixel white.
	composer.addPass(new SMAAPass());
	return composer;
}

/** `text` with `from` once replaced by `to`; three's shader changing under us throws. */
function swap(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`three's GTAO shader has no ${from}`);
	return text.replace(from, to);
}
