/** Milliseconds without a frame after which the view is still, not slow. */
const IDLE_MS = 500;

/**
 * Frames drawn a second, over the last second, and how long the slowest one's work
 * took (moving the camera and the doors, drawing, metering): the view draws only
 * when something changes, so a pause between frames is not a slow frame. It reads
 * while something moves and says nothing while all is still.
 */
export class FrameRate {
	private readonly frames: { t: number; ms: number }[] = [];

	/** A frame drawn at `now`, its work `ms` long. */
	frame(now: number, ms: number): void {
		this.frames.push({ t: now, ms });
		while (this.frames.length > 0 && this.frames[0].t < now - 1000) this.frames.shift();
	}

	/** Frames in the second before `now`, and the longest one's work (ms); none while still. */
	reading(now: number): { fps: number; slowest: number } | undefined {
		const last = this.frames.at(-1);
		if (last === undefined || now - last.t > IDLE_MS) return undefined;
		const recent = this.frames.filter((f) => f.t > now - 1000);
		return { fps: recent.length, slowest: Math.round(Math.max(...recent.map((f) => f.ms))) };
	}
}
