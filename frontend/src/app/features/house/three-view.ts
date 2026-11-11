import type { NgZone } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FrameRate } from './frame-rate';
import { GpuTimer } from './gpu-timer';

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

	/** What moves the camera in place of the orbit controls, once set (walking):
	 *  its update moves it for a frame and says whether it is still moving. */
	private mover?: { update(): boolean; dispose(): void };

	private frame = 0;
	private framePending = false;
	private readonly owned: { dispose(): void }[] = [];
	private readonly resize: ResizeObserver;

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
			this.frame = requestAnimationFrame(() => {
				const start = performance.now();
				this.framePending = false;
				let moving = false;
				if (this.mover) moving = this.mover.update();
				else this.controls.update();
				if (this.beforeRender?.(performance.now())) moving = true;
				// The GPU timed over what it draws for the frame and for its metering.
				this.gpu?.begin();
				this.renderer.render(this.scene, this.camera);
				const more = this.afterRender?.(performance.now()) ?? false;
				this.gpu?.end();
				const end = performance.now();
				this.frames.frame(end, end - start);
				for (const ms of this.gpu?.done() ?? []) this.frames.gpu(end, ms);
				if (moving || more) this.requestFrame();
			});
		});
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
		this.controls.dispose();
		// A renderer's dispose frees only its own state; geometries, materials and
		// textures stay on the GPU until each is disposed.
		for (const r of this.owned) r.dispose();
		this.renderer.dispose();
	}

	private aspect(): number {
		return this.host.clientWidth / (this.host.clientHeight || 400);
	}

	private onResize(): void {
		this.renderer.setSize(this.host.clientWidth, this.host.clientHeight || 400);
		this.camera.aspect = this.aspect();
		this.camera.updateProjectionMatrix();
		this.requestFrame();
	}
}
