import * as THREE from 'three';

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
 * Exposure that follows the view, as a phone camera's does: a small linear copy of
 * each changed view is metered, and the exposure eases to put its log-average at
 * `key`. `key` is set so the room the exposure was fitted in keeps it.
 */
export class AutoExposure {
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
		private readonly key: number,
		private readonly base: number,
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
