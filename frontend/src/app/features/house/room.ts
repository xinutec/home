import {
	AfterViewInit,
	Component,
	ElementRef,
	NgZone,
	OnDestroy,
	inject,
	signal,
	viewChild,
} from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { catchError, forkJoin, of } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute } from '@angular/router';
import { scaffoldTitle } from '@xinutec/ui-scaffold';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

import { decodeLightmap, encodeLightmap } from './bake-file';
import { addReflections, applyLightmap, roomChecksum } from './baked-light';
import { bakeLightmap } from './baker';
import type { HouseScene } from './house.model';
import { cameraFromQuery } from './camera';
import type { CameraQuery } from './camera';
import { buildInterior } from './room-builder';
import type { Lit } from './room-builder';
import { overcastSky, overcastSkyImage } from './sky';
import { ThreeView } from './three-view';
import { WalkControls, obstaclesOf } from './walk';

/** Inflates a gzipped lightmap: the browser's own stream, no library. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Bytes as base64, in slices: a spread of the whole would overflow the stack. */
function base64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

/** The everyday view's exposure in baked light (the sky's zenith is 1): between
 *  what compare-view solves against keyframes 1 and 822 (180, 80). */
const BAKED_EXPOSURE = 150;
/** Milliseconds of path tracing a frame under `?trace`: the page stays responsive. */
const TRACE_BUDGET_MS = 30;

/**
 * `/house/:room`: one room from inside, lit and in its materials.
 *
 * `?trace=N` is the physically based reference: lit only by the sky outside,
 * through the windows, and path-traced to N samples a pixel, after which the
 * canvas carries `data-traced`. Without it, the approximate everyday view.
 * `?tone=linear` drops the tone curve, so a pixel is exposure times radiance.
 */
@Component({
	selector: 'app-room',
	templateUrl: './room.html',
	styleUrl: './room.scss',
	imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
})
export class RoomPage implements AfterViewInit, OnDestroy {
	readonly empty = signal(false);
	readonly error = signal(false);
	readonly loading = signal(false);
	/** Walking the room in the first person (not while tracing or baking). */
	readonly walking = signal(false);
	/** Whether the walker has looked or moved yet: the hint shows until then. */
	readonly moved = signal(false);
	/** With `?stats`: what one frame costs, once measured. */
	readonly stats = signal('');
	readonly room = inject(ActivatedRoute).snapshot.paramMap.get('room') ?? '';

	private http = inject(HttpClient);
	private zone = inject(NgZone);
	private host = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
	private stick = viewChild.required<ElementRef<HTMLDivElement>>('stick');
	private view?: ThreeView;
	private tracer?: WebGLPathTracer;
	private readonly query: CameraQuery = cameraFromQuery(window.location.search);

	constructor() {
		scaffoldTitle(() => (this.room ? this.room[0].toUpperCase() + this.room.slice(1) : 'Room'));
	}

	ngAfterViewInit(): void {
		const view = new ThreeView(this.host().nativeElement, this.zone, (r) => {
			// Linear still scales by the exposure; NoToneMapping would drop it too.
			r.toneMapping = this.query.linear ? THREE.LinearToneMapping : THREE.ACESFilmicToneMapping;
			r.outputColorSpace = THREE.SRGBColorSpace;
			r.shadowMap.enabled = true;
			r.shadowMap.type = THREE.PCFSoftShadowMap;
			r.toneMappingExposure = this.query.exposure ?? 1;
		});
		this.view = view;
		if (this.query.trace || this.query.export) {
			// The physical reference: the room lit by the sky outside, through its windows alone.
			const sky = view.own(overcastSky());
			view.scene.environment = sky;
			view.scene.background = sky;
		} else {
			// Light that has bounced around a room, for what the sun does not reach.
			const pmrem = new THREE.PMREMGenerator(view.renderer);
			view.scene.environment = view.own(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
			view.scene.environmentIntensity = 0.45;
			pmrem.dispose();
			view.scene.background = new THREE.Color(0xcfd8de); // overcast sky, through the windows
		}
		this.load();
	}

	/** A failed load is the error state, never "no such room": 404 alone is absent. */
	load(): void {
		this.loading.set(true);
		this.error.set(false);
		this.empty.set(false);
		// The bake may be missing (404) or stale; either way the room is drawn without it.
		const bake = this.http
			.get('/api/house/bake', { responseType: 'arraybuffer' })
			.pipe(catchError(() => of(undefined)));
		forkJoin([this.http.get<HouseScene>('/api/house'), bake]).subscribe({
			next: ([scene, baked]) => {
				this.loading.set(false);
				const view = this.view;
				if (!view) return;
				const physical = !!this.query.trace || !!this.query.export;
				const lit = buildInterior(view, scene, this.room, this.query, physical);
				if (!lit) this.empty.set(true);
				else if (this.query.export) this.export(view);
				else if (this.query.trace) this.trace(view, this.query.trace);
				else if (this.query.bake) this.bake(view, lit, this.query.bake);
				else {
					void this.light(view, lit, baked);
					this.walk(view, scene);
				}
				view.requestFrame();
			},
			error: (e) => {
				this.loading.set(false);
				if (e instanceof HttpErrorResponse && e.status === 404) this.empty.set(true);
				else this.error.set(true);
			},
		});
	}

	/** Path-traces `samples` samples a pixel, then marks the canvas `data-traced`. */
	private trace(view: ThreeView, samples: number): void {
		view.paused = true;
		const tracer = new WebGLPathTracer(view.renderer);
		this.tracer = tracer;
		tracer.bounces = 8;
		tracer.transmissiveBounces = 6;
		// Whole samples, as many as fit in a frame's budget: the default, a ninth of
		// one a frame, holds a fast GPU to the screen's 60 Hz.
		tracer.tiles.set(1, 1);
		tracer.setScene(view.scene, view.camera);
		const host = this.host().nativeElement;
		const pixel = new Float32Array(4);
		const step = () => {
			if (this.tracer !== tracer) return;
			const start = performance.now();
			do {
				tracer.renderSample();
				// A pixel of the result, so the budget is the GPU's time, not the queue's
				// (gl.finish() does not wait in Chromium).
				view.renderer.readRenderTargetPixels(tracer.target, 0, 0, 1, 1, pixel);
			} while (tracer.samples < samples && performance.now() - start < TRACE_BUDGET_MS);
			if (tracer.samples >= samples) host.dataset['traced'] = String(Math.floor(tracer.samples));
			else requestAnimationFrame(step);
		};
		this.zone.runOutsideAngular(() => requestAnimationFrame(step));
	}

	/** Hands the camera to a walker: from the room's own view, standing, unless the
	 *  URL placed the camera (a comparison with a photo keeps its exact pose). */
	private walk(view: ThreeView, scene: HouseScene): void {
		const standing = !this.query.eye;
		const walker = new WalkControls(
			view.camera,
			view.renderer.domElement,
			this.stick().nativeElement,
			obstaclesOf(scene),
			() => {
				if (!this.moved()) this.zone.run(() => this.moved.set(true));
				view.requestFrame();
			},
			standing,
		);
		view.useMover(walker);
		this.walking.set(true);
	}

	/** Lights the room from its lightmap, if one came and it is for this room as built;
	 *  else it keeps the approximate light. */
	private async light(view: ThreeView, lit: Lit, baked: ArrayBuffer | undefined): Promise<void> {
		const map = baked ? await decodeLightmap(baked, gunzip) : undefined;
		const applied = !!map && applyLightmap(view.scene, lit, map);
		if (applied) for (const t of addReflections(view.renderer, view.scene, lit)) view.own(t);
		view.renderer.toneMappingExposure = this.query.exposure ?? (applied ? BAKED_EXPOSURE : 1);
		view.requestFrame();
		if (this.query.stats) this.measure(view);
	}

	/** Writes the physical scene, as `trace` would draw it, as binary glTF on
	 *  `window.houseExport` for e2e/export.ts; the canvas's host then carries
	 *  `data-exported`. glTF has no area lights and no environment, so the scene's
	 *  extras carry them: each frosted pane's light (centre, facing, size, radiance),
	 *  the sky as an equirectangular image of linear RGB floats (row 0 the nadir),
	 *  and the camera, the canvas's size and the exposure. */
	private export(view: ThreeView): void {
		const host = this.host().nativeElement;
		view.paused = true;
		const run = async () => {
			const scene = view.scene;
			scene.updateMatrixWorld(true);
			const lights: object[] = [];
			scene.traverse((o) => {
				if (!(o instanceof THREE.RectAreaLight)) return;
				const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(
					o.getWorldQuaternion(new THREE.Quaternion()),
				);
				const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
					o.getWorldQuaternion(new THREE.Quaternion()),
				);
				lights.push({
					centre: o.getWorldPosition(new THREE.Vector3()).toArray(),
					facing: facing.toArray(),
					up: up.toArray(),
					size: [o.width, o.height],
					radiance: o.color.clone().multiplyScalar(o.intensity).toArray(),
				});
			});
			// The image scene.environment was made from (the constructor's overcastSky).
			const { width, height, data } = overcastSkyImage();
			const rgb = new Float32Array(width * height * 3);
			for (let i = 0; i < width * height; i++) rgb.set(data.subarray(i * 4, i * 4 + 3), i * 3);
			const cam = view.camera;
			const canvas = view.renderer.domElement;
			const ratio = view.renderer.getPixelRatio();
			scene.userData = {
				lights,
				sky: { width, height, rgb: base64(new Uint8Array(rgb.buffer)) },
				camera: {
					position: cam.position.toArray(),
					quaternion: cam.quaternion.toArray(),
					fov: cam.fov,
				},
				image: [Math.round(canvas.width / ratio), Math.round(canvas.height / ratio)],
				exposure: view.renderer.toneMappingExposure,
			};
			const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
			if (!(glb instanceof ArrayBuffer))
				throw new Error('the exporter wrote JSON, not binary glTF');
			Object.assign(window, { houseExport: new Uint8Array(glb) });
			host.dataset['exported'] = JSON.stringify({ bytes: glb.byteLength, lights: lights.length });
		};
		this.zone.runOutsideAngular(() => {
			void run().catch(
				(e: unknown) => (host.dataset['exported'] = JSON.stringify({ error: String(e) })),
			);
		});
	}

	/** Bakes the room's lightmap, `samples` a pixel, and leaves it, as scenes/house.bake
	 *  stores it before compression, on `window.houseBake` for e2e/bake.ts; the
	 *  canvas's host then carries `data-baked`. */
	private bake(view: ThreeView, lit: Lit, samples: number): void {
		const host = this.host().nativeElement;
		const started = performance.now();
		const report = (done: number) => (host.dataset['baking'] = String(done));
		const run = async () => {
			const { light, summed } = await bakeLightmap(view.renderer, lit, samples, 4, report);
			const { width, height } = lit.atlas;
			const file = encodeLightmap(light, width, height, roomChecksum(lit));
			// The room it is for, beside it, for e2e scripts that inspect the light.
			Object.assign(window, { houseBake: file, houseRoom: lit, houseLight: light });
			host.dataset['baked'] = JSON.stringify({
				atlas: [width, height],
				covered: lit.atlas.charts,
				samples: summed,
				seconds: Math.round((performance.now() - started) / 100) / 10,
			});
		};
		// A failed bake says so on the host, for e2e/bake.ts to report.
		view.paused = true;
		this.zone.runOutsideAngular(() => {
			void run().catch(
				(e: unknown) => (host.dataset['baked'] = JSON.stringify({ error: String(e) })),
			);
		});
	}

	/** Draws frames back to back for 3 s after a second's warm-up (shaders compile on
	 *  the first frames), then puts on the canvas's host what one costs: frames a
	 *  second, draw calls, triangles and the meshes in the scene. */
	private measure(view: ThreeView): void {
		const host = this.host().nativeElement;
		view.paused = true;
		const r = view.renderer;
		let frames = 0;
		let start = 0;
		const step = (t: number) => {
			if (!this.view) return;
			r.render(view.scene, view.camera);
			if (!start) start = t + 1000;
			if (t >= start) frames++;
			else frames = 0;
			if (frames < 2 || t - start < 3000) {
				requestAnimationFrame(step);
				return;
			}
			let meshes = 0;
			view.scene.traverse((o) => {
				if (o instanceof THREE.Mesh) meshes++;
			});
			const fps = Math.round(((frames - 1) * 1000) / (t - start));
			const { calls, triangles } = r.info.render;
			const pixels = [r.domElement.width, r.domElement.height];
			host.dataset['stats'] = JSON.stringify({ fps, calls, triangles, meshes, pixels });
			this.zone.run(() =>
				this.stats.set(
					`${fps} fps · ${calls} draw calls · ${triangles} triangles · ${meshes} meshes · ${pixels.join('×')} px`,
				),
			);
		};
		this.zone.runOutsideAngular(() => requestAnimationFrame(step));
	}

	ngOnDestroy(): void {
		this.tracer?.dispose();
		this.tracer = undefined;
		this.view?.dispose();
	}
}
