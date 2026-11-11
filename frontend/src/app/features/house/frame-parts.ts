/** A frame's work, ms, past which it is reported: a 60 Hz frame's budget and a bit;
 *  at 120 Hz a frame past it has cost the screen at least two refreshes. */
export const SLOW_MS = 20;
/** Milliseconds between batches sent, and the most slow frames one carries. */
const SEND_EVERY_MS = 10_000;
const MOST_A_BATCH = 50;

/** One slow frame: when (epoch ms), where, how long, and each part's share. */
export interface SlowFrame {
	at: number;
	room: string;
	ms: number;
	parts: Record<string, number>;
}

/**
 * How long each part of a frame took: `begin` at its start, `mark(name)` after each
 * part (the time since the last mark is that part's; a name marked twice adds up),
 * `end` for the whole and its parts.
 */
export class FrameParts {
	private parts: Record<string, number> = {};
	private start = 0;
	private last = 0;

	begin(now: number): void {
		this.parts = {};
		this.start = this.last = now;
	}

	mark(name: string, now = performance.now()): void {
		this.parts[name] = (this.parts[name] ?? 0) + (now - this.last);
		this.last = now;
	}

	end(now = performance.now()): { ms: number; parts: Record<string, number> } {
		if (now > this.last) this.mark('other', now);
		return { ms: now - this.start, parts: this.parts };
	}
}

/**
 * The view's slow frames, sent to the home server (POST /api/house/frames) as they
 * come, a batch every SEND_EVERY_MS and one more as the page is hidden: what makes
 * walking stutter on a phone, in its log and table. Best effort: a batch that fails
 * (signed out, offline) is dropped, not retried.
 */
export class SlowFrames {
	private slow: SlowFrame[] = [];
	private frames = 0;
	private readonly timer: number;
	private readonly hidden = () => {
		if (document.visibilityState === 'hidden') this.send(true);
	};

	constructor(
		private readonly room: string,
		private readonly post: (body: string, leaving: boolean) => void = postFrames,
	) {
		this.timer = window.setInterval(() => this.send(false), SEND_EVERY_MS);
		document.addEventListener('visibilitychange', this.hidden);
	}

	/** A frame drawn, its work `ms` long, by part. */
	frame(ms: number, parts: Record<string, number>): void {
		this.frames++;
		if (ms <= SLOW_MS || this.slow.length >= MOST_A_BATCH) return;
		const rounded = Object.fromEntries(
			Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10]),
		);
		this.slow.push({
			at: Date.now(),
			room: this.room,
			ms: Math.round(ms * 10) / 10,
			parts: rounded,
		});
	}

	dispose(): void {
		window.clearInterval(this.timer);
		document.removeEventListener('visibilitychange', this.hidden);
		this.send(true);
	}

	private send(leaving: boolean): void {
		if (this.frames === 0) return;
		const body = JSON.stringify({
			device: navigator.userAgent,
			frames: this.frames,
			slow: this.slow,
		});
		this.slow = [];
		this.frames = 0;
		this.post(body, leaving);
	}
}

/** Sends a batch: as a beacon while the page goes, which outlives it; else a fetch. */
function postFrames(body: string, leaving: boolean): void {
	const url = '/api/house/frames';
	if (leaving && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
	// Best effort, not retried; said, so a batch that never arrives is not silent.
	void fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }).catch(
		(e: unknown) => console.warn('slow frames not sent', e),
	);
}
