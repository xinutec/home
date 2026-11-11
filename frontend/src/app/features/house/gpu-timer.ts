/** The browser's GPU timer for WebGL2 (`EXT_disjoint_timer_query_webgl2`). */
interface TimerExt {
	TIME_ELAPSED_EXT: number;
	GPU_DISJOINT_EXT: number;
}

/** Whether `e` is the timer extension. */
function isTimer(e: unknown): e is TimerExt {
	return typeof e === 'object' && e !== null && 'TIME_ELAPSED_EXT' in e && 'GPU_DISJOINT_EXT' in e;
}

/**
 * How long the GPU takes to draw a frame, by the browser's timer queries: one
 * opened before a frame's drawing and closed after, its answer read a frame or two
 * later, when the GPU has it. A browser without the timer (some phones') has none:
 * `of` says so, and the view shows that rather than a CPU time in its place. A
 * reading taken while the GPU was disturbed (`GPU_DISJOINT_EXT`: a clock change, a
 * context switch) is dropped.
 */
export class GpuTimer {
	private readonly waiting: WebGLQuery[] = [];
	private open?: WebGLQuery;

	private constructor(
		private readonly gl: WebGL2RenderingContext,
		private readonly ext: TimerExt,
	) {}

	/** The timer of `gl`'s browser, if it has one. */
	static of(gl: WebGL2RenderingContext): GpuTimer | undefined {
		const ext: unknown = gl.getExtension('EXT_disjoint_timer_query_webgl2');
		return isTimer(ext) ? new GpuTimer(gl, ext) : undefined;
	}

	/** Starts timing what is drawn next; one at a time. */
	begin(): void {
		if (this.open) throw new Error('a GPU timing is already open');
		const q = this.gl.createQuery();
		this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
		this.open = q;
	}

	/** Stops timing; its answer comes from `done` once the GPU has it. */
	end(): void {
		if (!this.open) throw new Error('no GPU timing is open');
		this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
		this.waiting.push(this.open);
		this.open = undefined;
	}

	/** The timings the GPU has answered since last asked, in milliseconds. */
	done(): number[] {
		const gl = this.gl;
		const out: number[] = [];
		const disjoint: unknown = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
		while (this.waiting.length > 0) {
			const q = this.waiting[0];
			if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) break;
			const ns: unknown = gl.getQueryParameter(q, gl.QUERY_RESULT);
			if (disjoint !== true && typeof ns === 'number') out.push(ns / 1e6);
			gl.deleteQuery(q);
			this.waiting.shift();
		}
		return out;
	}
}
