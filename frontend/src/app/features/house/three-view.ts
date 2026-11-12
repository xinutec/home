import type { NgZone } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FrameRate } from './frame-rate';
import { GpuTimer } from './gpu-timer';
import { FrameParts } from './frame-parts';
import type { ImageStage } from './image-stage';

/**
 * The plumbing every 3D screen shares: a renderer in a host element, a camera,
 * orbit controls, resizing, frames drawn on demand, and disposal of everything
 * handed to `own`.
 *
 * Drawn on demand, not 60 times a second: a gesture, and the damping after it
 * (update() fires `change` until it settles), each ask for a frame.
 */
export class ThreeView {
	readonly scene = new THREE.Scene();
	readonly renderer: THREE.WebGLRenderer;
	readonly camera: THREE.PerspectiveCamera;
	readonly controls: OrbitControls;

	/** The frames drawn, for a frame-rate readout. */
	readonly frames = new FrameRate();
	/** The GPU's timer, if the browser has one: `frames` then says the GPU's time. */
	readonly gpu: GpuTimer | undefined;

	/** While true, nothing is drawn here: something else owns the canvas (the path tracer). */
	paused = false;

	/** Runs before each frame (a door swinging); true asks for another. */
	beforeRender?: (now: number) => boolean;

	/** Runs after each frame (auto exposure); true asks for another. */
	afterRender?: (now: number) => boolean;

	/** Told each frame's GPU time (ms) as its timer gives it (`?stats`). */
	onGpuTime?: (ms: number) => void;

	/** Each frame's work timed by part: the loop marks its own, `beforeRender` may
	 *  mark finer ones (`parts.mark`). */
	readonly parts = new FrameParts();
	/** Told each frame, as it ends: how long after the frame before it it was shown
	 *  (its work, where it followed none), and its work's parts. */
	onFrame?: (seen: number, parts: Record<string, number>) => void;

	/** What moves the camera in place of the orbit controls, once set (walking):
	 *  its update moves it for a frame and says whether it is still moving. */
	private mover?: { update(): boolean; dispose(): void };

	private frame = 0;
	/** When the last frame was shown (the browser's frame time), and whether it asked
	 *  for the next straight on: then the next one's gap is what the eye sees. */
	private shownAt?: number;
	private followed = false;
	/** When the view last changed for a reason of its own (ms): the image stage
	 *  settles after it (`ImageStage.settling`). */
	private active = 0;
	/** What draws the frame, if not the renderer straight to the canvas. */
	private stage?: ImageStage;
	private framePending = false;
	private readonly owned: { dispose(): void }[] = [];
	private readonly resize: ResizeObserver;
	/** Hidden, no frame is shown: the next one's gap is not the eye's. */
	private readonly hidden = () => {
		if (document.visibilityState === 'hidden') this.followed = false;
	};

	constructor(
		private readonly host: HTMLElement,
		private readonly zone: NgZone,
		setup: (renderer: THREE.WebGLRenderer) => void = () => undefined,
	) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(host.clientWidth, host.clientHeight || 400);
		setup(this.renderer);
		host.appendChild(this.renderer.domElement);
		const gl = this.renderer.getContext();
		this.gpu = gl instanceof WebGL2RenderingContext ? GpuTimer.of(gl) : undefined;

		this.camera = new THREE.PerspectiveCamera(50, this.aspect(), 0.05, 200);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.addEventListener('change', () => this.requestFrame());

		this.resize = new ResizeObserver(() => this.onResize());
		this.resize.observe(host);
		document.addEventListener('visibilitychange', this.hidden);
	}

	/** Kept for disposal when the view closes. */
	own<T extends { dispose(): void }>(resource: T): T {
		this.owned.push(resource);
		return resource;
	}

	requestFrame(): void {
		if (this.paused || this.framePending) return;
		this.framePending = true;
		this.zone.runOutsideAngular(() => {
			this.frame = requestAnimationFrame((shown) => {
				const start = performance.now();
				// What the eye sees: how long after the frame before this one is shown, if
				// it followed straight on; the GPU falling behind lengthens it.
				const gap = this.followed && this.shownAt !== undefined ? shown - this.shownAt : undefined;
				this.shownAt = shown;
				this.parts.begin(start);
				this.framePending = false;
				let moving = false;
				if (this.mover) moving = this.mover.update();
				else this.controls.update();
				this.parts.mark('walk');
				if (this.beforeRender?.(performance.now())) moving = true;
				this.parts.mark('before');
				// The GPU timed over what it draws for the frame and for its metering.
				this.gpu?.begin();
				// The last time something other than the image's settling moved the view.
				if (moving) this.active = start;
				if (this.stage) {
					this.stage.composer.render();
					if (this.stage.settling(start - this.active, start)) moving = true;
				} else this.renderer.render(this.scene, this.camera);
				this.parts.mark('draw');
				const more = this.afterRender?.(performance.now()) ?? false;
				if (more) this.active = start;
				this.gpu?.end();
				this.parts.mark('after');
				const end = performance.now();
				this.frames.frame(end, end - start, gap);
				const work = this.parts.end(end);
				this.onFrame?.(gap ?? work.ms, work.parts);
				for (const ms of this.gpu?.done() ?? []) {
					this.frames.gpu(end, ms);
					this.onGpuTime?.(ms);
				}
				this.followed = moving || more;
				if (this.followed) this.requestFrame();
			});
		});
	}

	/** Draws each frame through `stage` from now on. */
	useStage(stage: ImageStage): void {
		this.stage = stage;
		const composer = stage.composer;
		composer.setPixelRatio(window.devicePixelRatio);
		composer.setSize(this.host.clientWidth, this.host.clientHeight || 400);
		this.requestFrame();
	}

	/** Hands the camera to `mover`; the orbit controls stop. */
	useMover(mover: { update(): boolean; dispose(): void }): void {
		this.controls.dispose();
		this.mover = mover;
		this.requestFrame();
	}

	dispose(): void {
		cancelAnimationFrame(this.frame);
		this.mover?.dispose();
		this.resize.disconnect();
		document.removeEventListener('visibilitychange', this.hidden);
		this.controls.dispose();
		// A renderer's dispose frees only its own state; geometries, materials and
		// textures stay on the GPU until each is disposed.
		for (const r of this.owned) r.dispose();
		// The composer frees its own buffers, not its passes'.
		for (const pass of this.stage?.composer.passes ?? []) pass.dispose();
		this.stage?.composer.dispose();
		this.renderer.dispose();
	}

	private aspect(): number {
		return this.host.clientWidth / (this.host.clientHeight || 400);
	}

	private onResize(): void {
		this.renderer.setSize(this.host.clientWidth, this.host.clientHeight || 400);
		this.stage?.composer.setSize(this.host.clientWidth, this.host.clientHeight || 400);
		this.camera.aspect = this.aspect();
		this.camera.updateProjectionMatrix();
		this.requestFrame();
	}
}
