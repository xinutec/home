/** Milliseconds without a frame after which the view is still, not slow. */
const IDLE_MS = 500;

/**
 * Frames drawn a second, over the last second, how long the slowest one's work
 * took on the CPU (moving the camera and the doors, issuing the draw, metering),
 * and how long the slowest took the GPU to draw (`GpuTimer`, where the browser
 * has one): the view draws only when something changes, so a pause between frames
 * is not a slow frame. It reads while something moves and says nothing while all
 * is still.
 */
export class FrameRate {
	private readonly frames: { t: number; ms: number }[] = [];
	private readonly drawn: { t: number; ms: number }[] = [];

	/** A frame drawn at `now`, its work `ms` long. */
	frame(now: number, ms: number): void {
		this.frames.push({ t: now, ms });
		while (this.frames.length > 0 && this.frames[0].t < now - 1000) this.frames.shift();
	}

	/** The GPU's time for a recent frame, `ms`, as it came at `now`. */
	gpu(now: number, ms: number): void {
		this.drawn.push({ t: now, ms });
		while (this.drawn.length > 0 && this.drawn[0].t < now - 1000) this.drawn.shift();
	}

	/** Frames in the second before `now`, the longest one's work (ms), and the GPU's
	 *  longest (ms) if its timer said; none while still. */
	reading(now: number): { fps: number; slowest: number; gpu?: number } | undefined {
		const last = this.frames.at(-1);
		if (last === undefined || now - last.t > IDLE_MS) return undefined;
		const recent = this.frames.filter((f) => f.t > now - 1000);
		const drawn = this.drawn.filter((f) => f.t > now - 1000);
		return {
			fps: recent.length,
			slowest: Math.round(Math.max(...recent.map((f) => f.ms))),
			...(drawn.length > 0
				? { gpu: Math.round(Math.max(...drawn.map((f) => f.ms)) * 10) / 10 }
				: {}),
		};
	}
}
