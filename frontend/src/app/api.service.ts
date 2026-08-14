import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { mergeWindow, newestTs } from './history';
import {
	type ClaudeUsage,
	DEFAULT_RANGE,
	type DeviceLatest,
	type Measurement,
	type RangeKey,
	rangeMs,
} from './measurement.model';

const LATEST_REFRESH_MS = 60_000;

// How far back before the newest row held a refresh asks anyway. A receiver
// that pushes late writes a row behind the newest one already shown, which a
// query starting at that row would never see.
const DELTA_OVERLAP_MS = 10 * 60_000;

// How often the window is re-read whole instead of extended. The overlap above
// only covers ordinary lateness; geb spools while the network is down and can
// flush hours of readings at once, and nothing anchored to the newest row would
// ever notice those. Cheap enough at this interval, and it also repairs a
// window that drifted for any reason nobody has thought of.
const RECONCILE_MS = 15 * 60_000;

/**
 * Single data layer for the dashboard. Holds the latest reading per device and
 * the per-device history for the selected range as signals, drives a 60s
 * auto-refresh of `/api/devices`, and extends the history with what has arrived
 * since — reading the window whole on a range change, and periodically after.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
	private readonly http = inject(HttpClient);

	private readonly _devices = signal<DeviceLatest[]>([]);
	private readonly _devicesLoaded = signal(false);
	private readonly _devicesError = signal<string | null>(null);

	private readonly _historyByDevice = signal<Record<string, Measurement[]>>({});
	private readonly _historyLoading = signal(false);
	private readonly _historyError = signal<string | null>(null);

	private readonly _range = signal<RangeKey>(DEFAULT_RANGE);

	private readonly _usage = signal<ClaudeUsage | null>(null);
	/** Freshest Claude Code usage snapshot, or null until one is pushed. */
	readonly usage = this._usage.asReadonly();

	/**
	 * Latest reading per climate/air device, UI-ordered. Power-monitor plugs are
	 * excluded here so they don't render as empty room cards; see `powerDevices`.
	 */
	readonly devices = computed(() => this._devices().filter((d) => !d.label.power));
	/** Latest reading per smart-plug power monitor, for the power section. */
	readonly powerDevices = computed(() => this._devices().filter((d) => d.label.power));
	/** True once the first `/api/devices` response has been handled. */
	readonly devicesLoaded = this._devicesLoaded.asReadonly();
	readonly devicesError = this._devicesError.asReadonly();

	/** The whole-home air-quality sensor (CO₂/PM/AQI), or `null` if absent. */
	readonly airDevice = computed(() => this._devices().find((d) => d.label.airQuality) ?? null);

	/** Oldest-first readings for the selected range, keyed by device id. */
	readonly historyByDevice = this._historyByDevice.asReadonly();
	readonly historyLoading = this._historyLoading.asReadonly();
	readonly historyError = this._historyError.asReadonly();

	readonly range = this._range.asReadonly();

	/** True when the API has confirmed there is genuinely no data to show. */
	readonly isEmpty = computed(() => this._devicesLoaded() && this._devices().length === 0);

	private timer: ReturnType<typeof setInterval> | null = null;

	// Guards against out-of-order history responses: a slow in-flight fetch for
	// the previous range must not overwrite the newer range's data when it lands.
	private historyGeneration = 0;

	// When the window was last read whole. Zero forces the next refresh to do so,
	// which is how a range change gets the rows a delta could not reach back for.
	private lastFullFetch = 0;

	/** Load devices + history, then auto-refresh both on a timer. */
	start(): void {
		void this.init();
		this.timer ??= setInterval(() => {
			void this.refreshDevices();
			// Quiet so the charts stay live without flashing the progress bar.
			void this.refreshHistory(true);
			void this.refreshUsage();
		}, LATEST_REFRESH_MS);
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Change the active history window and refetch. */
	setRange(range: RangeKey): void {
		if (range === this._range()) {
			return;
		}
		this._range.set(range);
		this.lastFullFetch = 0;
		void this.refreshHistory();
	}

	private async init(): Promise<void> {
		await this.refreshDevices();
		await this.refreshHistory();
		await this.refreshUsage();
	}

	async refreshUsage(): Promise<void> {
		try {
			const row = await firstValueFrom(this.http.get<ClaudeUsage | null>('/api/usage'));
			this._usage.set(row ?? null);
		} catch {
			// Leave the last snapshot in place; a transient miss shouldn't blank it.
		}
	}

	async refreshDevices(): Promise<void> {
		try {
			const rows = await firstValueFrom(this.http.get<DeviceLatest[]>('/api/devices'));
			this._devices.set(rows ?? []);
			this._devicesError.set(null);
		} catch {
			this._devicesError.set('Could not reach the sensor service.');
		} finally {
			this._devicesLoaded.set(true);
		}
	}

	async refreshHistory(quiet = false): Promise<void> {
		const generation = ++this.historyGeneration;
		const devices = this._devices().map((d) => d.device);
		if (devices.length === 0) {
			this._historyByDevice.set({});
			return;
		}
		const to = new Date();
		const windowStart = to.getTime() - rangeMs(this._range());
		// ⚠ **A refresh asks for what it does not already hold.** Re-reading the
		// whole window each minute is what this used to do, and it cost 1.0 MiB a
		// minute on the default range and 17.9 MiB on 30 days (measured
		// 2026-08-14, 65,007 rows across eight devices) to learn a handful of new
		// readings. The rows already held do not change; only the recent end grows.
		const whole = to.getTime() - this.lastFullFetch >= RECONCILE_MS;
		const held = this._historyByDevice();

		if (!quiet) {
			this._historyLoading.set(true);
		}
		try {
			const entries = await Promise.all(
				devices.map(async (device) => {
					const prev = whole ? [] : (held[device] ?? []);
					const newest = newestTs(prev);
					const from =
						newest === null ? windowStart : Math.max(windowStart, newest - DELTA_OVERLAP_MS);
					const params = new HttpParams()
						.set('from', new Date(from).toISOString())
						.set('to', to.toISOString())
						.set('device', device)
						.set('limit', '20000');
					const rows = await firstValueFrom(
						this.http.get<Measurement[]>('/api/measurements', { params }),
					);
					return [device, mergeWindow(prev, rows ?? [], windowStart)] as const;
				}),
			);
			if (generation !== this.historyGeneration) {
				return; // A newer refresh superseded this one; drop the stale result.
			}
			this._historyByDevice.set(Object.fromEntries(entries));
			this._historyError.set(null);
			if (whole) {
				this.lastFullFetch = to.getTime();
			}
		} catch {
			if (generation === this.historyGeneration) {
				this._historyError.set('Could not load history.');
			}
		} finally {
			if (!quiet && generation === this.historyGeneration) {
				this._historyLoading.set(false);
			}
		}
	}
}
