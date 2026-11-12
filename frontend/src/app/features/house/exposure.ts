import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** Samples across and down the frame its light is averaged from: a phone's meter
 *  reads a coarse grid, not every pixel. */
const METER_GRID = 32;
/** The metered exposure's pixels across, and milliseconds between its meterings
 *  while the view changes (`MeteredExposure`). */
const METER_WIDTH = 32;
const METER_EVERY_MS = 250;
/** Seconds for the exposure to go most of the way (1 - 1/e) to a new metering. */
const ADAPT_SECONDS = 0.6;
/** How far either way of its starting exposure the meter may take it. */
const RANGE = 10;
/** Milliseconds the view keeps drawing after it last changed, for the exposure to
 *  settle: over three ADAPT_SECONDS, 97% of the way. */
const SETTLE_MS = 2000;

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
 * Exposure that follows the view, as a phone camera's does, worked out on the GPU:
 * the frame's light (before the tone curve) averaged in stops over a METER_GRID ×
 * METER_GRID grid into one pixel, and the exposure, another pixel, eased each frame
 * toward putting that average at `key`, within RANGE of `base` either way. The
 * camera pass multiplies by it (`texture`). Nothing is read back: a read-back,
 * even one that should not wait, held a phone's frame 18-23 ms.
 */
export class GpuExposure {
	private readonly average = pixel();
	private exposure = [pixel(), pixel()];
	private readonly averaging = quad(`
		uniform sampler2D frame;
		void main() {
			float sum = 0.0;
			for (int i = 0; i < ${METER_GRID}; i++)
				for (int j = 0; j < ${METER_GRID}; j++) {
					vec2 uv = (vec2(float(i), float(j)) + 0.5) / ${METER_GRID}.0;
					vec3 c = texture2D(frame, uv).rgb;
					sum += log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6));
				}
			gl_FragColor = vec4(sum / ${METER_GRID * METER_GRID}.0, 0.0, 0.0, 1.0);
		}`);
	private readonly easing = quad(`
		uniform sampler2D average;
		uniform sampler2D before;
		uniform float key;
		uniform float base;
		uniform float ease;
		uniform float first;
		void main() {
			float wanted = clamp(key / exp(texture2D(average, vec2(0.5)).r), base / ${RANGE}.0, base * ${RANGE}.0);
			float was = texture2D(before, vec2(0.5)).r;
			gl_FragColor = vec4(first > 0.5 ? wanted : was * pow(wanted / was, ease), 0.0, 0.0, 1.0);
		}`);
	private last?: number;
	private changed = -Infinity;

	constructor(
		private key: number,
		private readonly base: number,
	) {}

	/** The exposure, its red: what the camera pass multiplies the light by. */
	get texture(): THREE.Texture {
		return this.exposure[0].texture;
	}

	/** Aims at `key` from now on (the evening's, the day's). */
	aim(key: number): void {
		this.key = key;
		this.changed = -Infinity;
	}

	/** Meters `frame` and eases the exposure, at `now` (ms). */
	update(renderer: THREE.WebGLRenderer, frame: THREE.Texture, now: number): void {
		const dt = this.last === undefined ? 0 : (now - this.last) / 1000;
		const first = this.last === undefined;
		this.last = now;
		const before = renderer.getRenderTarget();
		uniformsOf(this.averaging)['frame'].value = frame;
		renderer.setRenderTarget(this.average);
		this.averaging.render(renderer);
		const u = uniformsOf(this.easing);
		u['average'].value = this.average.texture;
		u['before'].value = this.exposure[0].texture;
		u['key'].value = this.key;
		u['base'].value = this.base;
		u['ease'].value = 1 - Math.exp(-dt / ADAPT_SECONDS);
		u['first'].value = first ? 1 : 0;
		renderer.setRenderTarget(this.exposure[1]);
		this.easing.render(renderer);
		renderer.setRenderTarget(before);
		this.exposure.reverse();
	}

	/** Whether to keep drawing, the view last changed `quiet` ms ago (or the key
	 *  did): the exposure settles only as frames are drawn. */
	settling(quiet: number, now: number): boolean {
		if (this.changed === -Infinity) this.changed = now;
		return quiet < SETTLE_MS || now - this.changed < SETTLE_MS;
	}

	dispose(): void {
		for (const t of [this.average, ...this.exposure]) t.dispose();
		for (const q of [this.averaging, this.easing]) {
			const m = q.material;
			if (m instanceof THREE.Material) m.dispose();
			q.dispose();
		}
	}
}

/** One pixel of half floats: a value the GPU keeps for itself. */
function pixel(): THREE.WebGLRenderTarget {
	return new THREE.WebGLRenderTarget(1, 1, {
		type: THREE.HalfFloatType,
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		depthBuffer: false,
	});
}

/** A full-screen pass of `fragment`, its uniforms found in it. */
function quad(fragment: string): FullScreenQuad {
	const uniforms: Record<string, THREE.IUniform> = {};
	for (const m of fragment.matchAll(/uniform \w+ (\w+);/g)) uniforms[m[1]] = { value: null };
	return new FullScreenQuad(
		new THREE.ShaderMaterial({
			uniforms,
			vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
			fragmentShader: fragment,
		}),
	);
}

function uniformsOf(q: FullScreenQuad): Record<string, THREE.IUniform> {
	const m = q.material;
	if (!(m instanceof THREE.ShaderMaterial)) throw new Error('an exposure pass lost its shader');
	return m.uniforms;
}

/**
 * Exposure that follows the view, for the view drawn straight to the screen (no
 * image stage, so no `GpuExposure`): a small linear copy of the changed view is
 * drawn and read back four times a second, and the renderer's exposure eases to
 * put its log-average at `key`. The read-back waits for the GPU, which in this
 * view's single pass is short.
 */
export class MeteredExposure {
	private readonly target: THREE.WebGLRenderTarget;
	private readonly pixels: Float32Array;
	private wanted?: number;
	private reading = 0;
	private metered = -Infinity;
	private last?: number;

	constructor(
		private readonly renderer: THREE.WebGLRenderer,
		private readonly scene: THREE.Scene,
		private readonly camera: THREE.PerspectiveCamera,
		private key: number,
		private readonly base: number,
	) {
		const h = Math.max(1, Math.round(METER_WIDTH / camera.aspect));
		this.target = new THREE.WebGLRenderTarget(METER_WIDTH, h, { type: THREE.FloatType });
		this.pixels = new Float32Array(METER_WIDTH * h * 4);
	}

	/** After a frame: meters if due, eases the exposure, and says whether it is still
	 *  easing (so another frame should follow). */
	update(now: number): boolean {
		if (now - this.metered >= METER_EVERY_MS) {
			this.metered = now;
			this.read();
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
	}

	private read(): void {
		const r = this.renderer;
		const before = r.getRenderTarget();
		// A render target gets no tone mapping: the copy holds the light as it is.
		r.setRenderTarget(this.target);
		r.render(this.scene, this.camera);
		r.readRenderTargetPixels(this.target, 0, 0, this.target.width, this.target.height, this.pixels);
		r.setRenderTarget(before);
		const avg = logAverage(this.pixels);
		this.reading = avg;
		if (avg > 0) {
			const e = this.key / avg;
			this.wanted = Math.min(this.base * RANGE, Math.max(this.base / RANGE, e));
		}
	}
}
