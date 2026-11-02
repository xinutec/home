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

import type { HouseScene } from './house.model';
import { cameraFromQuery } from './camera';
import { buildInterior } from './room-builder';
import { ThreeView } from './three-view';

/** `/house/:room`: one room from inside, lit and in its materials. */
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

	constructor() {
		scaffoldTitle(() => (this.room ? this.room[0].toUpperCase() + this.room.slice(1) : 'Room'));
	}

	ngAfterViewInit(): void {
		const view = new ThreeView(this.host().nativeElement, this.zone, (r) => {
			r.toneMapping = THREE.ACESFilmicToneMapping;
			r.outputColorSpace = THREE.SRGBColorSpace;
			r.shadowMap.enabled = true;
			r.shadowMap.type = THREE.PCFSoftShadowMap;
		});
		this.view = view;
		// Light that has bounced around a room, for what the sun does not reach.
		const pmrem = new THREE.PMREMGenerator(view.renderer);
		view.scene.environment = view.own(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
		view.scene.environmentIntensity = 0.45;
		pmrem.dispose();
		view.scene.background = new THREE.Color(0xcfd8de); // overcast sky, through the windows
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
				if (!buildInterior(view, scene, this.room, cameraFromQuery(window.location.search)))
					this.empty.set(true);
				view.requestFrame();
			},
			error: (e) => {
				this.loading.set(false);
				if (e instanceof HttpErrorResponse && e.status === 404) this.empty.set(true);
				else this.error.set(true);
			},
		});
	}

	ngOnDestroy(): void {
		this.view?.dispose();
	}
}
