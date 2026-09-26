import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { mergeWindow, newestTs } from './history';
import type * as Wire from '../../../src/wire';
import {
	type ClaudeUsage,
	DEFAULT_RANGE,
	type DeviceLatest,
	type Measurement,
	type RangeKey,
	parseDevice,
	parseMeasurement,
	parseUsage,
	rangeMs,
} from './measurement.model';

const LATEST_REFRESH_MS = 60_000;

// A refresh re-reads this far behind the newest row held: a late receiver
// writes rows older than that one.
const DELTA_OVERLAP_MS = 10 * 60_000;

// How often the whole window is re-read. A receiver that spooled through an
// outage flushes hours of rows at once, further back than the overlap reaches.
const RECONCILE_MS = 15 * 60_000;

/**
 * The app's data: latest reading per device, history for the selected range,
 * and Claude usage, refreshed every minute. History is extended with what is
 * new, and read whole on a range change and every `RECONCILE_MS`.
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

	/** Latest reading per climate/air device, UI-ordered. */
	readonly devices = computed(() => this._devices().filter((d) => !d.label.power));
	/** Latest reading per smart plug; nothing renders these yet. */
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

	// A slower, older fetch must not overwrite a newer one's result.
	private historyGeneration = 0;

	// When the window was last read whole; 0 forces the next refresh to.
	private lastFullFetch = 0;

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
			const row = await firstValueFrom(
				this.http.get<Wire.ClaudeUsage<string> | null>('/api/usage'),
			);
			this._usage.set(row === null ? null : parseUsage(row));
		} catch {
			// Leave the last snapshot in place; a transient miss shouldn't blank it.
		}
	}

	async refreshDevices(): Promise<void> {
		try {
			const rows = await firstValueFrom(this.http.get<Wire.DeviceLatest<string>[]>('/api/devices'));
			this._devices.set(rows.map(parseDevice));
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
		// Only what is not already held: re-reading a 30-day window every minute
		// costs megabytes to learn a handful of rows.
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
						this.http.get<Wire.Measurement<string>[]>('/api/measurements', { params }),
					);
					return [device, mergeWindow(prev, rows.map(parseMeasurement), windowStart)] as const;
				}),
			);
			if (generation !== this.historyGeneration) {
				return;
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
