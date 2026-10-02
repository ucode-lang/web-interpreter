// Client side of the interpreter worker: promise plumbing plus the watchdog.
//
// A runaway pen cannot be interrupted from inside the interpreter (ucode turns
// tail recursion into a jump, so even "infinite recursion" never overflows the
// stack), so the only reliable stop is to kill the worker and start a new one.
// That is cheap -- a fresh wasm instance plus VM costs a few tens of
// milliseconds -- and it means the page itself never freezes.

export const DEFAULT_TIMEOUT = 5000;

export class PenRunner {
	constructor(url, { timeoutMs = DEFAULT_TIMEOUT, onready } = {}) {
		this.url = url;
		this.timeoutMs = timeoutMs;
		this.onready = onready;
		this.seq = 0;
		this.pending = new Map();
		this.worker = null;
		this.busy = false;
		this.spawns = 0;
		this.spawn();
	}

	spawn() {
		this.worker = new Worker(this.url);

		this.worker.onmessage = (event) => {
			const data = event.data || {};

			if (data.type === 'ready') {
				this.spawns++;
				this.onready?.({ modules: data.modules });

				return;
			}

			const settle = this.pending.get(data.id);

			if (!settle)
				return;

			this.pending.delete(data.id);
			settle(data);
		};

		this.worker.onerror = (event) => {
			for (const [, settle] of this.pending)
				settle({ type: 'error', error: event.message || 'worker error' });

			this.pending.clear();
		};
	}

	/**
	 * Run a project. Resolves with the pipeline result, or with
	 * { timeout: true, ms } when the run outlived the budget (in which case the
	 * worker has been replaced and the next run starts from a clean slate).
	 */
	run(project) {
		const id = ++this.seq;
		const started = performance.now();

		this.busy = true;

		return new Promise((resolve) => {
			let done = false;

			const finish = (result) => {
				if (done)
					return;

				done = true;
				clearTimeout(timer);
				this.pending.delete(id);
				this.busy = false;
				resolve(result);
			};

			const timer = setTimeout(() => {
				const ms = Math.round(performance.now() - started);

				this.pending.delete(id);
				this.worker.terminate();
				this.spawn();
				finish({ timeout: true, ms });
			}, this.timeoutMs);

			this.pending.set(id, (data) => {
				if (data.type === 'result')
					finish(data.result);
				else
					finish({ ok: false, error: data.error || 'the interpreter failed', outputs: [], steps: [], console: '' });
			});

			this.worker.postMessage({ id, cmd: 'run', project });
		});
	}

	async ping() {
		const id = ++this.seq;

		return new Promise((resolve) => {
			this.pending.set(id, (data) => resolve(data));
			this.worker.postMessage({ id, cmd: 'ping' });
		});
	}

	dispose() {
		this.worker?.terminate();
	}
}