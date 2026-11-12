import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { partsOf, solidsOf } from './assembly';
import type { HouseScene } from './house.model';
import { named } from './materials';

/** Pixels across a pane's reflection: it is dim and a little blurred (a TV's glass,
 *  roughness 0.15), so far fewer than the screen's. */
const REFLECTION_WIDTH = 384;
/** Glass's reflectance looking straight at it; more at a glancing angle (Schlick). */
const GLASS_REFLECTANCE = 0.04;
/** Pixels of the reflection its blur spreads over (a Gaussian's sigma): a TV's
 *  glass (roughness 0.15) blurs the room a few metres off by centimetres. Round,
 *  not a mip level's square, which a lamp's light far brighter than the room
 *  showed as a white block that jumped as the eye moved. */
const BLUR = 3.5;
/** Taps each way from the middle of the blur, each pass: to three sigmas. */
const BLUR_TAPS = Math.ceil(3 * BLUR);

/** One pass of the blur, along `blurStep` (a pixel across, or up). */
const blurStep = new THREE.Vector2();
const blurPass = new THREE.ShaderMaterial({
	uniforms: { image: { value: null }, step: { value: blurStep } },
	vertexShader: /* glsl */ `
		varying vec2 vUv;
		void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
	fragmentShader: /* glsl */ `
		uniform sampler2D image;
		uniform vec2 step;
		varying vec2 vUv;
		void main() {
			vec3 sum = vec3( 0.0 );
			float weights = 0.0;
			for ( int i = -${BLUR_TAPS}; i <= ${BLUR_TAPS}; i++ ) {
				float w = exp( -0.5 * float( i * i ) / ${(BLUR * BLUR).toFixed(4)} );
				sum += w * texture2D( image, vUv + float( i ) * step ).rgb;
				weights += w;
			}
			gl_FragColor = vec4( sum / weights, 1.0 );
		}`,
});
/** Metres in front of its face the pane is drawn, clear of it in the depth buffer. */
const LIFT = 0.001;

/** The materials that are panes (`MaterialSpec.planar`) until the scene file says
 *  so itself: the bake is keyed by the file's every byte, and the next bake is the
 *  whole one that takes the doors out of it (doc/engine.md, step 6). */
const PLANAR = ['screen'];

/** `house` with those of PLANAR's materials it has marked as panes. */
export function withPlanar(house: HouseScene): HouseScene {
	const materials = { ...house.materials };
	for (const key of PLANAR) {
		const spec = materials[key];
		if (spec) materials[key] = { ...spec, planar: true };
	}
	return { ...house, materials };
}

/** The pane's light: the mirrored room, by glass's Fresnel reflectance, added to
 *  the face behind it (its own dark glass, lit as baked). */
const GLASS = {
	name: 'PlanarGlass',
	uniforms: {
		color: { value: null },
		tDiffuse: { value: null },
		textureMatrix: { value: null },
	},
	vertexShader: /* glsl */ `
		uniform mat4 textureMatrix;
		varying vec4 vUv;
		varying vec3 vToEye;
		varying vec3 vNormal;
		#include <common>
		#include <logdepthbuf_pars_vertex>
		void main() {
			vUv = textureMatrix * vec4( position, 1.0 );
			vec4 world = modelMatrix * vec4( position, 1.0 );
			vToEye = cameraPosition - world.xyz;
			vNormal = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
			gl_Position = projectionMatrix * viewMatrix * world;
			#include <logdepthbuf_vertex>
		}`,
	fragmentShader: /* glsl */ `
		uniform sampler2D tDiffuse;
		varying vec4 vUv;
		varying vec3 vToEye;
		varying vec3 vNormal;
		#include <logdepthbuf_pars_fragment>
		void main() {
			#include <logdepthbuf_fragment>
			float facing = clamp( dot( normalize( vToEye ), vNormal ), 0.0, 1.0 );
			float f = ${GLASS_REFLECTANCE} + ${1 - GLASS_REFLECTANCE} * pow( 1.0 - facing, 5.0 );
			gl_FragColor = vec4( texture2DProj( tDiffuse, vUv ).rgb * f, 1.0 );
			#include <tonemapping_fragment>
			#include <colorspace_fragment>
		}`,
};

/**
 * The room's flat glossy panes (`MaterialSpec.planar`: a TV's glass), each
 * reflecting the room as it is from where it is seen: the room drawn again from
 * the eye mirrored in the pane, into a small target, before the frame (`draw`),
 * where the pane is in view. On, a pane's probe reflection is off; off, it is back.
 */
export class PlanarReflections {
	private readonly panes: {
		mirror: Reflector;
		/** Where its blur's first pass goes, across. */
		across: THREE.WebGLRenderTarget;
		glass: THREE.ShaderMaterial;
		draw: Reflector['onBeforeRender'];
	}[] = [];
	private readonly materials: THREE.MeshStandardMaterial[] = [];
	private readonly frustum = new THREE.Frustum();
	private readonly quad = new FullScreenQuad(blurPass);
	/** Three's callback is given the group drawn; a pane is drawn whole. */
	private readonly whole = new THREE.Group();
	private shown = true;

	constructor(
		house: HouseScene,
		private readonly scene: THREE.Scene,
		meshes: THREE.Mesh[],
	) {
		for (const f of house.furniture)
			for (const p of partsOf(f)) {
				const key = p.material ?? f.material;
				if (!key || !named(house, key).planar) continue;
				const s = solidsOf(f).find((q) => q.part === p.id);
				if (!s) throw new Error(`no solid for ${f.id}/${p.id}`);
				const [w, h] = [2 * s.hw, s.y1 - s.y0];
				const mirror = new Reflector(new THREE.PlaneGeometry(w, h), {
					textureWidth: REFLECTION_WIDTH,
					textureHeight: Math.round((REFLECTION_WIDTH * h) / w),
					multisample: 0,
					shader: GLASS,
				});
				// Its front, +z turned by the part's yaw, a hair out from the face.
				const out = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
				mirror.position.set(s.x, (s.y0 + s.y1) / 2, s.z).addScaledVector(out, s.hd + LIFT);
				mirror.rotation.y = s.yaw;
				const glass = mirror.material;
				if (!(glass instanceof THREE.ShaderMaterial)) throw new Error('a pane lost its shader');
				glass.blending = THREE.AdditiveBlending;
				glass.depthWrite = false;
				glass.transparent = true;
				// Drawn before the frame, not in it: a phone's GPU pays for switching
				// targets mid-frame.
				const draw = mirror.onBeforeRender.bind(mirror);
				mirror.onBeforeRender = () => undefined;
				mirror.updateMatrixWorld();
				scene.add(mirror);
				const target = mirror.getRenderTarget();
				const across = new THREE.WebGLRenderTarget(target.width, target.height, {
					type: THREE.HalfFloatType,
				});
				this.panes.push({ mirror, across, glass, draw });
			}
		for (const m of meshes) {
			const material = m.material;
			if (
				material instanceof THREE.MeshStandardMaterial &&
				material.userData['planar'] === true &&
				!this.materials.includes(material)
			)
				this.materials.push(material);
		}
		this.show(true);
	}

	/** Reflects as it is, or as the room's probe saw it: to compare. */
	show(on: boolean): void {
		this.shown = on;
		for (const { mirror } of this.panes) mirror.visible = on;
		for (const m of this.materials) m.envMapIntensity = on ? 0 : 1;
	}

	/** Draws each pane in view's reflection from `camera`, before the frame. */
	draw(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
		if (!this.shown) return;
		camera.updateMatrixWorld();
		this.frustum.setFromProjectionMatrix(
			new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
		);
		for (const { mirror, across, glass, draw } of this.panes) {
			if (!this.frustum.intersectsObject(mirror)) continue;
			draw(renderer, this.scene, camera, mirror.geometry, glass, this.whole);
			this.blur(renderer, mirror.getRenderTarget(), across);
		}
	}

	/** Blurs `image` round (BLUR), across into `across`, then up back into it. */
	private blur(
		renderer: THREE.WebGLRenderer,
		image: THREE.WebGLRenderTarget,
		across: THREE.WebGLRenderTarget,
	): void {
		const before = renderer.getRenderTarget();
		const u = blurPass.uniforms;
		for (const [from, to, step] of [
			[image, across, new THREE.Vector2(1 / image.width, 0)],
			[across, image, new THREE.Vector2(0, 1 / image.height)],
		] as const) {
			u['image'].value = from.texture;
			blurStep.copy(step);
			renderer.setRenderTarget(to);
			this.quad.render(renderer);
		}
		renderer.setRenderTarget(before);
	}

	dispose(): void {
		for (const { mirror, across } of this.panes) {
			mirror.removeFromParent();
			mirror.dispose();
			across.dispose();
		}
		this.quad.dispose();
	}
}
