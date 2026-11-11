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
import { HttpClient, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import type { HttpResponse } from '@angular/common/http';
import { catchError, filter, forkJoin, map, of, tap } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute } from '@angular/router';
import { scaffoldTitle } from '@xinutec/ui-scaffold';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

import { type Lightmap, decodeLightmap } from './bake-file';
import { LiveLight, addReflections, applyLightmap, showDaylight } from './baked-light';
import { withModels } from './assembly';
import type { HouseScene } from './house.model';
import { cameraFromQuery } from './camera';
import { AutoExposure } from './exposure';
import type { CameraQuery } from './camera';
import { buildInterior } from './room-builder';
import { type LastBake, bakeHouse, fetchLastBake, lampRegions } from './house-bake';
import type { Lit } from './room-builder';
import { Lamps } from './lamps';
import { Dynamics, loadRapier } from './dynamics';
import { Movables } from './movables';
import { ProbeLight } from './probes';
import { nightSkyImage, overcastSky, overcastSkyImage } from './sky';
import { ThreeView } from './three-view';
import { Joints } from './joints';
import { WalkControls } from './walk';
import { Occluders } from './occluders';

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
/** The log-average linear light auto exposure brings to the screen's middle: keyframe
 *  1's view meters 0.00136 (`data-meter`), so the living room keeps about its fitted
 *  exposure, and the kitchen, metering ten times brighter, gets a tenth of it. */
const AUTO_KEY = 0.2;
/** AUTO_KEY in the evening: a lamp-lit room is darker than a daylit one, and a
 *  camera keeps it so. */
const EVENING_KEY = 0.1;
/** Milliseconds between frame-rate readouts. */
const FPS_READ_MS = 500;
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
	/** How much of the bake has come, in percent, while it downloads; else unknown
	 *  (the scene alone, or the room being built from it). */
	readonly progress = signal<number | undefined>(undefined);
	/** Walking the room in the first person (not while tracing or baking). */
	readonly walking = signal(false);
	/** A mouse and keys, not a finger: the hint says how to walk by them. */
	readonly mouse = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
	/** Whether the walker has looked or moved yet: the hint shows until then. */
	readonly moved = signal(false);
	/** Frames a second while the view moves, and the slowest frame; `idle` while still. */
	readonly fps = signal('');
	/** With `?stats`: what one frame costs, once measured. */
	readonly stats = signal('');
	readonly room = inject(ActivatedRoute).snapshot.paramMap.get('room') ?? '';

	private http = inject(HttpClient);
	private zone = inject(NgZone);
	private host = viewChild.required<ElementRef<HTMLDivElement>>('canvas');
	private stick = viewChild.required<ElementRef<HTMLDivElement>>('stick');
	private crosshair = viewChild.required<ElementRef<HTMLDivElement>>('crosshair');
	private view?: ThreeView;
	private tracer?: WebGLPathTracer;
	/** The light as doors open and lamps switch, once a lightmap applies. */
	private liveLight?: LiveLight;
	/** The lamps, once a lightmap with their light applies. */
	private lamps?: Lamps;
	/** The lamps' light in rooms they are not in, once a lightmap with it applies. */
	private farLight?: ProbeLight;
	/** All the light probes' light, for what moves. */
	private movesLight?: ProbeLight;
	/** What moves, as it shades the room and itself, once a lightmap applies. */
	private occluders?: Occluders;
	/** The reflections, to capture again when the light changes. */
	private recapture?: () => void;
	private auto?: AutoExposure;
	private readonly query: CameraQuery = cameraFromQuery(window.location.search);
	private fpsTimer = 0;

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
		// Read twice a second, outside Angular; the page changes only when the text does.
		this.zone.runOutsideAngular(() => {
			this.fpsTimer = window.setInterval(() => {
				const r = view.frames.reading(performance.now());
				const text = r ? `${r.fps} fps · slowest ${r.slowest} ms` : 'idle';
				if (text !== this.fps()) this.zone.run(() => this.fps.set(text));
			}, FPS_READ_MS);
		});
		if ((this.query.trace || this.query.export) && this.query.night) {
			// Night: nothing outside; the room is lit by its ceiling lights (buildInterior).
			view.scene.environment = null;
			view.scene.background = new THREE.Color(0, 0, 0);
		} else if (this.query.trace || this.query.export) {
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
		this.progress.set(undefined);
		this.error.set(false);
		this.empty.set(false);
		// The bake may be missing (404) or stale; either way the room is drawn without it.
		// Megabytes, most of the wait: the bar shows how much has come.
		const bake = this.http
			.get('/api/house/bake', {
				responseType: 'arraybuffer',
				reportProgress: true,
				observe: 'events',
			})
			.pipe(
				tap((e) => {
					if (e.type === HttpEventType.DownloadProgress && e.total)
						this.progress.set((100 * e.loaded) / e.total);
				}),
				filter((e): e is HttpResponse<ArrayBuffer> => e.type === HttpEventType.Response),
				map((r) => r.body ?? undefined),
				// Come: what is left (decoding, building) has no measure.
				tap(() => this.progress.set(undefined)),
				catchError(() => of(undefined)),
			);
		forkJoin([this.http.get<HouseScene>('/api/house'), bake]).subscribe({
			next: ([scene, baked]) => void this.open(withModels(scene), baked),
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
	 *  URL placed the camera (a comparison with a photo keeps its exact pose). A tap
	 *  on a door or drawer opens it, or shuts it; on a lamp, switches it, and it is
	 *  evening while one is on (`?night`: every one, from the start; `?lamps=a,b`:
	 *  those); on a thing that can be picked up, picks it up, and a tap again lets it
	 *  go. */
	private async walk(view: ThreeView, joints: Joints, lit: Lit, scene: HouseScene): Promise<void> {
		const standing = !this.query.eye;
		const lamps = this.lamps;
		const canvas = view.renderer.domElement;
		// The one world the walker, the doors and the things are in, built once the
		// room is drawn. Its build time on the host, to measure (`data-physics`, ms).
		const physicsFrom = performance.now();
		const dynamics = view.own(new Dynamics(await loadRapier(), lit.meshes));
		const movables = new Movables(
			view.renderer,
			view.scene,
			lit.movables,
			dynamics,
			this.movesLight,
			(r) => view.own(r),
			(key) => {
				const how = scene.furniture.find((f) => f.id === key)?.movable;
				if (!how) throw new Error(`${key} is not movable`);
				return how;
			},
			this.occluders,
		);
		// What moves takes the daylight by day, and every lamp at its weight.
		const lightMoves = () =>
			this.movesLight?.show((source) =>
				source === undefined
					? lamps?.evening
						? [0, 0, 0]
						: [1, 1, 1]
					: (lamps?.weight(source) ?? [0, 0, 0]),
			);
		lightMoves();
		const show = () =>
			this.liveLight?.show(
				(key) => joints.openness(key),
				(key) => lamps?.weight(key) ?? [0, 0, 0],
				lamps?.evening ? 0 : 1,
			);
		view.beforeRender = (now) => {
			const opening = joints.update(now);
			const carried = movables.update(now, view.camera);
			// A door or drawer stops on what it cannot push away, as a real one does.
			for (const key of movables.jammed()) joints.stop(key);
			show();
			return opening || carried;
		};
		// The light all through: the lamps' glow, the windows, the lightmap, then what
		// the reflections see of it, and the exposure's aim.
		const switched = () => {
			if (!lamps) return;
			lamps.showGlow();
			this.farLight?.show((source) => (source === undefined ? [0, 0, 0] : lamps.weight(source)));
			lightMoves();
			showDaylight(view.scene, lamps.evening ? 0 : 1);
			show();
			this.recapture?.();
			this.auto?.aim(lamps.evening ? EVENING_KEY : AUTO_KEY);
			view.requestFrame();
		};
		if (lamps && this.query.night) lamps.allOn();
		for (const key of this.query.lamps ?? []) lamps?.toggle(key);
		if (lamps && (this.query.night || this.query.lamps)) switched();
		const caster = new THREE.Raycaster();
		const tapped = (x: number, y: number) => {
			const box = canvas.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((x - box.left) / box.width) * 2 - 1,
				-((y - box.top) / box.height) * 2 + 1,
			);
			caster.setFromCamera(ndc, view.camera);
			if (movables.holding) {
				movables.drop();
				view.requestFrame();
				return;
			}
			const thing = movables.pick(caster.ray, lit.meshes);
			if (thing) {
				movables.hold(thing, view.camera);
				view.requestFrame();
				return;
			}
			const lamp = lamps?.pick(caster.ray);
			if (lamps && lamp) {
				lamps.toggle(lamp);
				switched();
				return;
			}
			const joint = joints.pick(caster.ray);
			if (!joint) return;
			joints.toggle(joint, performance.now());
			view.requestFrame();
		};
		const walker = new WalkControls(
			view.camera,
			view.renderer.domElement,
			this.stick().nativeElement,
			dynamics,
			() => {
				if (!this.moved()) this.zone.run(() => this.moved.set(true));
				view.requestFrame();
			},
			standing,
			tapped,
			this.crosshair().nativeElement,
		);
		view.useMover(walker);
		this.walking.set(true);
		canvas.dataset['physics'] = String(Math.round(performance.now() - physicsFrom));
		view.requestFrame();
	}

	/** Builds the room the scene describes, its atlas laid out to the bake's (where
	 *  each chart was baked), then walks it, or bakes, traces or exports it. A whole
	 *  bake lays its atlas out afresh. */
	private async open(scene: HouseScene, baked: ArrayBuffer | undefined): Promise<void> {
		const map = baked ? await decodeLightmap(baked, gunzip) : undefined;
		this.loading.set(false);
		const view = this.view;
		if (!view) return;
		const physical = !!this.query.trace || !!this.query.export;
		const fresh = !!this.query.bake && !this.query.since;
		const lit = buildInterior(
			view,
			scene,
			this.room,
			this.query,
			physical,
			fresh ? undefined : map?.layout,
		);
		if (!lit) this.empty.set(true);
		else if (this.query.export) this.export(view);
		else if (this.query.trace) this.trace(view, this.query.trace);
		else if (this.query.bake) {
			const since = this.query.since && map ? await fetchLastBake(map) : undefined;
			const joints = new Joints(scene, lit.meshes);
			this.bake(view, joints, lit, this.query.bake, since, !!this.query.shut, scene);
		} else {
			const joints = new Joints(scene, lit.meshes);
			this.light(view, scene, lit, map);
			void this.walk(view, joints, lit, scene);
		}
		view.requestFrame();
	}

	/** Lights the room from its lightmap, if one came and it is for this room as built;
	 *  else it keeps the approximate light. */
	private light(view: ThreeView, scene: HouseScene, lit: Lit, map: Lightmap | undefined): void {
		const texture = map && applyLightmap(view.scene, lit, map);
		const applied = !!texture;
		// The lamps can light the room only from a bake that has their light.
		if (map && texture && map.lamps.length > 0) {
			this.lamps = new Lamps(scene, lit.meshes);
			// Before the reflections copy the materials: each glowing part glows alone.
			for (const m of this.lamps.ownMaterials()) view.own(m);
		}
		if (map && texture && (map.joints.length > 0 || map.lamps.length > 0))
			this.liveLight = view.own(
				new LiveLight(
					view.renderer,
					view.scene,
					texture,
					map.joints,
					map.lamps,
					map.pairs,
					lit.meshes,
				),
			);
		if (map && texture && map.probes.length > 0) {
			// A room's surfaces take only the lamps of other rooms: the rest is their
			// lightmap's.
			const lampRoom = new Map(lampRegions(scene).map((l) => [l.key, l.room]));
			this.farLight = view.own(
				new ProbeLight(map.probes, (g) => g.lamp !== undefined && lampRoom.get(g.lamp) !== g.room),
			);
			this.movesLight = view.own(new ProbeLight(map.probes, () => true));
		}
		if (applied && lit.movables.length > 0) this.occluders = new Occluders();
		if (applied) {
			const reflections = addReflections(
				view.renderer,
				view.scene,
				lit,
				this.farLight,
				this.occluders,
			);
			for (const t of reflections.owned) view.own(t);
			this.recapture = reflections.recapture;
		}
		view.renderer.toneMappingExposure = this.query.exposure ?? (applied ? BAKED_EXPOSURE : 1);
		if (applied && this.query.exposure === undefined && AutoExposure.supported(view.renderer)) {
			const auto = view.own(
				new AutoExposure(view.renderer, view.scene, view.camera, AUTO_KEY, BAKED_EXPOSURE),
			);
			this.auto = auto;
			const canvas = view.renderer.domElement;
			view.afterRender = (now) => {
				const easing = auto.update(now);
				canvas.dataset['meter'] = auto.meter.toPrecision(3);
				return easing;
			};
		}
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
			// The image scene.environment was made from (the constructor's overcastSky),
			// or at night a black one.
			const { width, height, data } = this.query.night ? nightSkyImage() : overcastSkyImage();
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

	/** Bakes the house's light (`bakeHouse`), `since` the bake the page is fed if
	 *  asked, and leaves it, as scenes/house.bake stores it before compression, on
	 *  `window.houseBake` for e2e/bake.ts, with its raw sums and the surfaces it saw
	 *  for the next bake; the canvas's host then carries `data-baked`. */
	private bake(
		view: ThreeView,
		joints: Joints,
		lit: Lit,
		samples: number,
		since: LastBake | undefined,
		shutOnly: boolean,
		scene: HouseScene,
	): void {
		const host = this.host().nativeElement;
		const run = async () => {
			const baked = await bakeHouse(
				view.renderer,
				lit,
				joints,
				samples,
				(done, of) => (host.dataset['baking'] = `${done} of ${of}`),
				since,
				shutOnly,
				scene,
			);
			// The room it is for, beside it, for e2e scripts that inspect the light.
			Object.assign(window, {
				houseBake: baked.file,
				houseRaw: baked.raw,
				houseSurfaces: baked.seen,
				houseRoom: lit,
				houseLight: baked.light,
			});
			host.dataset['baked'] = JSON.stringify(baked.report);
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
		window.clearInterval(this.fpsTimer);
		this.tracer?.dispose();
		this.tracer = undefined;
		this.view?.dispose();
	}
}
