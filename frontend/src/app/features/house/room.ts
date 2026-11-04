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
import { WebGLPathTracer } from 'three-gpu-pathtracer';

import { decodeBake, encodeBake } from './bake-file';
import { applyBake, roomChecksum } from './baked-light';
import { bakeIrradiance } from './baker';
import type { HouseScene } from './house.model';
import { cameraFromQuery } from './camera';
import type { CameraQuery } from './camera';
import { buildInterior } from './room-builder';
import { overcastSky } from './sky';
import { ThreeView } from './three-view';

/** The everyday view's exposure in baked light (the sky's zenith is 1): between
 *  what compare-view solves against keyframes 1 and 822 (180, 80). */
const BAKED_EXPOSURE = 150;

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
	/** With `?stats`: what one frame costs, once measured. */
	readonly stats = signal('');
	readonly room = inject(ActivatedRoute).snapshot.paramMap.get('room') ?? '';

	private http = inject(HttpClient);
	private zone = inject(NgZone);
	private host = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
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
		if (this.query.trace) {
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
				const physical = !!this.query.trace;
				const merged = buildInterior(view, scene, this.room, this.query, physical);
				if (!merged) this.empty.set(true);
				else if (this.query.trace) this.trace(view, this.query.trace);
				else if (this.query.bake) this.bake(view, merged, this.query.bake);
				else {
					const decoded = baked ? decodeBake(baked) : undefined;
					const lit = !!decoded && applyBake(view.scene, merged, decoded);
					view.renderer.toneMappingExposure = this.query.exposure ?? (lit ? BAKED_EXPOSURE : 1);
					if (this.query.stats) this.measure(view);
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
		tracer.setScene(view.scene, view.camera);
		const host = this.host().nativeElement;
		const step = () => {
			if (this.tracer !== tracer) return;
			tracer.renderSample();
			if (tracer.samples >= samples) host.dataset['traced'] = String(Math.floor(tracer.samples));
			else requestAnimationFrame(step);
		};
		this.zone.runOutsideAngular(() => requestAnimationFrame(step));
	}

	/** Bakes the room's light, `samples` a vertex, and leaves it, encoded as
	 *  scenes/house.bake stores it, on `window.houseBake` for e2e/bake.ts; the
	 *  canvas's host then carries `data-baked`. */
	private bake(view: ThreeView, merged: THREE.Mesh[], samples: number): void {
		const host = this.host().nativeElement;
		const started = performance.now();
		const report = (done: number) => (host.dataset['baking'] = String(done));
		const run = async () => {
			const { front, back, summed } = await bakeIrradiance(
				view.renderer,
				merged,
				samples,
				4,
				report,
			);
			const file = encodeBake({ checksum: roomChecksum(merged), front, back });
			Object.assign(window, { houseBake: file });
			host.dataset['baked'] = JSON.stringify({
				vertices: front.length / 3,
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
