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
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute } from '@angular/router';
import { scaffoldTitle } from '@xinutec/ui-scaffold';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

import type { HouseScene } from './house.model';
import { cameraFromQuery } from './camera';
import type { CameraQuery } from './camera';
import { buildInterior } from './room-builder';
import { overcastSky } from './sky';
import { ThreeView } from './three-view';

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
		this.http.get<HouseScene>('/api/house').subscribe({
			next: (scene) => {
				this.loading.set(false);
				const view = this.view;
				if (!view) return;
				const physical = !!this.query.trace;
				if (!buildInterior(view, scene, this.room, this.query, physical)) this.empty.set(true);
				else if (this.query.trace) this.trace(view, this.query.trace);
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

	ngOnDestroy(): void {
		this.tracer?.dispose();
		this.tracer = undefined;
		this.view?.dispose();
	}
}
