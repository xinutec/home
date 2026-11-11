import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** Metering pixels across: a phone's meter reads a coarse grid, not every pixel. */
const METER_WIDTH = 32;
/** Milliseconds between meterings while the view changes. */
const METER_EVERY_MS = 250;
/** Seconds for the exposure to go most of the way (1 - 1/e) to a new metering. */
const ADAPT_SECONDS = 0.6;
/** How far either way of its starting exposure the meter may take it. */
const RANGE = 10;

/** The log-average luminance of linear RGBA pixels, as a camera's meter reads it:
 *  a window's glare counts, but does not swamp the room. */
export function logAverage(rgba: ArrayLike<number>): number {
	let sum = 0;
	let n = 0;
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		const l = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
		sum += Math.log(Math.max(l, 1e-6));
		n++;
	}
	return n ? Math.exp(sum / n) : 0;
}

/** The exposure eased `dt` seconds toward `target`, evenly in stops. */
export function easeExposure(current: number, target: number, dt: number): number {
	const k = 1 - Math.exp(-dt / ADAPT_SECONDS);
	return current * Math.pow(target / current, k);
}

/**
 * Exposure that follows the view, as a phone camera's does: the frame the image
 * stage drew (`frame`, its light before the tone curve), shrunk to METER_WIDTH
 * across in one pass, is read back without waiting for the GPU (a read that waits
 * stalls a phone's frame for tens of ms), and the exposure eases to put its
 * log-average at `key`. `key` is set so the room the exposure was fitted in keeps
 * it. Until a frame is given there is nothing to meter, and the exposure stays.
 */
export class AutoExposure {
	private readonly target: THREE.WebGLRenderTarget;
	private readonly pixels: Float32Array;
	private readonly shrink = new FullScreenQuad(
		new THREE.ShaderMaterial({
			uniforms: { frame: { value: null } },
			vertexShader: `
				varying vec2 vUv;
				void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
			fragmentShader: `
				uniform sampler2D frame;
				varying vec2 vUv;
				void main() { gl_FragColor = texture2D(frame, vUv); }`,
		}),
	);
	private wanted?: number;
	private reading = 0;
	private metered = -Infinity;
	/** Whether a reading is on its way back from the GPU. */
	private pending = false;
	private last?: number;
	/** The frame to meter, the image stage's, once walking. */
	frame?: () => THREE.Texture | undefined;

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		camera: THREE.PerspectiveCamera,
		private key: number,
		private readonly base: number,
		/** Asks for a frame: a metering arrived, and the exposure has to ease to it. */
		private readonly redraw: () => void,
	) {
		const h = Math.max(1, Math.round(METER_WIDTH / camera.aspect));
		this.target = new THREE.WebGLRenderTarget(METER_WIDTH, h, { type: THREE.FloatType });
		this.pixels = new Float32Array(METER_WIDTH * h * 4);
	}

	/** Whether the renderer can draw and read the float copy the meter needs. */
	static supported(renderer: THREE.WebGLRenderer): boolean {
		return renderer.extensions.has('EXT_color_buffer_float');
	}

	/** After a frame: meters if due, eases the exposure, and says whether it is still
	 *  easing (so another frame should follow). */
	update(now: number): boolean {
		if (now - this.metered >= METER_EVERY_MS && !this.pending) {
			const frame = this.frame?.();
			if (frame) {
				this.metered = now;
				this.read(frame);
			}
		}
		const r = this.renderer;
		const dt = this.last === undefined ? 0 : (now - this.last) / 1000;
		this.last = now;
		if (this.wanted === undefined) return false;
		r.toneMappingExposure = easeExposure(r.toneMappingExposure, this.wanted, dt);
		const easing = Math.abs(Math.log(this.wanted / r.toneMappingExposure)) > 0.01;
		if (!easing) this.last = undefined;
		return easing;
	}

	/** Aims at `key` from now on, metering again at once. */
	aim(key: number): void {
		this.key = key;
		this.metered = -Infinity;
	}

	/** The log-average linear light of the last metering. */
	get meter(): number {
		return this.reading;
	}

	dispose(): void {
		this.target.dispose();
		this.shrink.dispose();
		const m = this.shrink.material;
		if (m instanceof THREE.Material) m.dispose();
	}

	/** Shrinks `frame` into the meter's target, and reads it back when the GPU has it. */
	private read(frame: THREE.Texture): void {
		const r = this.renderer;
		const m = this.shrink.material;
		if (!(m instanceof THREE.ShaderMaterial)) throw new Error('the meter lost its shader');
		m.uniforms['frame'].value = frame;
		const before = r.getRenderTarget();
		r.setRenderTarget(this.target);
		this.shrink.render(r);
		r.setRenderTarget(before);
		this.pending = true;
		const { width, height } = this.target;
		void r
			.readRenderTargetPixelsAsync(this.target, 0, 0, width, height, this.pixels)
			.then(() => {
				this.pending = false;
				const avg = logAverage(this.pixels);
				this.reading = avg;
				if (avg > 0) {
					const e = this.key / avg;
					this.wanted = Math.min(this.base * RANGE, Math.max(this.base / RANGE, e));
					this.redraw();
				}
			})
			.catch((e: unknown) => {
				// Said, and metered again next time: the exposure holds meanwhile.
				this.pending = false;
				console.warn('the exposure meter could not read the frame', e);
			});
	}
}
