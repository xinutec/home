import type { NgZone } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

	/** While true, nothing is drawn here: something else owns the canvas (the path tracer). */
	paused = false;

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
				this.framePending = false;
				this.controls.update();
				this.renderer.render(this.scene, this.camera);
			});
		});
	}

	dispose(): void {
		cancelAnimationFrame(this.frame);
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
