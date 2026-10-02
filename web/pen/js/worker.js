// Web Worker that owns the ucode interpreter.
//
// The interpreter runs synchronously, and ucode optimises tail calls into jumps
// -- `function f(n) { return f(n + 1) }` is therefore an endless loop rather
// than a stack overflow. Nothing short of killing the thread can stop that, so
// the wasm lives here and the UI thread is free to terminate() this worker when
// a run exceeds its time budget, then start a fresh one.
//
// This is a classic worker, because the emscripten glue is a UMD script rather
// than an ES module; the pipeline modules are pulled in with dynamic import().

importScripts('../../ucode.js');

let bridge = null;
let runnerSource = null;
let runProject = null;
let fatal = null;
let booting = null;

async function boot() {
	if (bridge || fatal)
		return;

	const [{ makeBridge }, pipeline, runner] = await Promise.all([
		import('./bridge.js'),
		import('./pipeline.js'),
		fetch('../runner.uc').then((res) => (res.ok
			? res.text()
			: Promise.reject(new Error(`could not load runner.uc (HTTP ${res.status})`)))),
	]);

	runProject = pipeline.runProject;
	runnerSource = runner;

	// The glue resolves ucode.wasm relative to this script, which would look for
	// it next to the worker; point it at the runtime directory instead.
	bridge = makeBridge(await globalThis.ucodeWasm({
		locateFile: (path) => new URL('../../' + path, self.location.href).href,
	}));

	self.postMessage({ type: 'ready', modules: bridge.moduleCount() });
}

function ensureBooted() {
	if (!booting) {
		booting = boot().catch((err) => {
			fatal = String(err && err.message ? err.message : err);

			self.postMessage({ type: 'fatal', error: fatal });
		});
	}

	return booting;
}

self.onmessage = async (event) => {
	const { id, cmd, project } = event.data || {};

	try {
		if (cmd === 'ping') {
			await ensureBooted();
			self.postMessage({ id, type: 'pong', modules: bridge ? bridge.moduleCount() : 0 });

			return;
		}

		if (cmd !== 'run')
			throw new Error(`unknown command "${cmd}"`);

		await ensureBooted();

		if (fatal)
			throw new Error(fatal);

		const result = runProject(bridge, project, { runnerSource });

		self.postMessage({ id, type: 'result', result });
	}
	catch (err) {
		self.postMessage({
			id,
			type: 'error',
			error: String(err && err.stack ? err.stack : err && err.message ? err.message : err),
		});
	}
};

ensureBooted();