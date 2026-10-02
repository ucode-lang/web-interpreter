// The run pipeline: project in, results out.
//
// Deliberately free of any browser or worker API -- it only talks to a bridge
// (see bridge.js), so the exact same code runs inside the Web Worker in the
// browser and against dist/ucode.js in a node test.
//
// A run is always from scratch: the interpreter is reset, /pen/ is rebuilt from
// the editor buffers, and runner.uc does the rest. Reproducible runs matter more
// than the few milliseconds a fresh VM costs.

import { manifest, projectFiles } from './project.js';
import { topLevelDecls, publishFooter } from './scan.js';

export const PEN_ROOT = '/pen';
export const OUT_DIR = '/pen/.out';
export const MANIFEST = '/pen/.pen.json';
export const RUNNER = '/pen/.runner.uc';

const HTML_HINT = /<(?:!doctype|html|head|body|div|span|p|table|ul|ol|li|h[1-6]|style|script|section|main|header|footer|form|input|button|svg|a |link|meta|br|img|pre|code|blockquote|nav|article)\b/i;

export function looksLikeHtml(text) {
	const head = String(text || '').slice(0, 4000);

	return HTML_HINT.test(head.trimStart());
}

/**
 * The files to mirror into the virtual filesystem, with the publish footer
 * appended to every script (see scan.js for why).
 */
export function preparedFiles(project, { root = PEN_ROOT } = {}) {
	return projectFiles(project).map((f) => {
		let content = f.content;

		if (f.kind === 'script')
			content += publishFooter(topLevelDecls(content));

		return { path: f.path, kind: f.kind, key: f.key, content };
	});
}

/** Map a runner-side path back to the file name shown in the tabs. */
export function projectPathOf(path, root = PEN_ROOT) {
	if (typeof path !== 'string')
		return null;

	const rel = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;

	return rel.startsWith('.out/') ? null : rel;
}

function readJson(bridge, path) {
	const text = bridge.readFile(path);

	if (!text)
		return null;

	try {
		return JSON.parse(text);
	}
	catch {
		return null;
	}
}

/**
 * Execute a project.
 *
 * @param bridge  a makeBridge() wrapper around the wasm module
 * @param project the pen model
 * @param opts    { runnerSource, root }
 * @returns {ok, ms, console, error, outputs, steps, inspect, manifest}
 */
export function runProject(bridge, project, opts = {}) {
	const { runnerSource, root = PEN_ROOT } = opts;
	const started = Date.now();

	if (!runnerSource)
		throw new Error('runProject needs the runner source');

	const man = manifest(project);
	const files = preparedFiles(project, { root });

	bridge.reset();
	bridge.clearDir(root);

	for (const f of files)
		bridge.writeFile(`${root}/${f.path}`, f.content);

	bridge.writeFile(MANIFEST, JSON.stringify(man));
	bridge.writeFile(RUNNER, runnerSource);

	const run = bridge.runFile(RUNNER);

	// Everything the scripts printed, plus anything the runner itself printed.
	const consoleText = bridge.output() || run.output || '';
	const stderrText = bridge.stderr() || '';
	const bridgeError = bridge.error() || run.error || '';

	const report = readJson(bridge, `${root}/.out/report.json`);

	if (!report) {
		return {
			ok: false,
			ms: Date.now() - started,
			console: consoleText,
			stderr: stderrText,
			error: bridgeError || 'the runner produced no report (did it compile?)',
			outputs: [],
			steps: [],
			inspect: null,
			manifest: man,
		};
	}

	const outputs = (report.outputs || []).map((o, i) => {
		const text = bridge.readFile(o.path) ?? '';

		return {
			name: o.name || `output ${i + 1}`,
			path: o.path,
			text,
			bytes: o.bytes ?? text.length,
			html: looksLikeHtml(text),
		};
	});

	// Normalise the runner's report into something the UI can render directly.
	const steps = (report.steps || []).map((s) => ({
		kind: s.kind,
		name: s.name,
		ok: !!s.ok,
		ms: s.ms ?? 0,
		error: s.error ? normalizeError(s.error, root, s) : null,
	}));

	return {
		ok: !!report.ok,
		ms: Date.now() - started,
		console: consoleText,
		stderr: stderrText,
		error: steps.find((s) => s.error)?.error?.text || bridgeError,
		firstError: steps.find((s) => s.error) || null,
		outputs,
		steps,
		inspect: readJson(bridge, `${root}/.out/inspect.json`),
		manifest: man,
		tree: bridge.listDir(root).filter((e) => !e.path.includes('/.out/')),
		skipped: report.skipped || 0,
	};
}

/**
 * Turn a runner exception into a detail object the UI can render.
 *
 * The stacktrace frames carry the source path, which is how an error can point
 * back at the tab (and line) the user has to fix. Compile errors are the
 * exception: they are raised by the runner itself, so every frame is internal
 * and the position has to be read out of the compiler's message instead.
 */
export function normalizeError(err, root = PEN_ROOT, step = null) {
	const frames = (err.frames || []).map((f) => {
		const file = projectPathOf(f.file, root);

		return {
			file,
			line: f.line ?? null,
			byte: f.byte ?? null,
			function: f.function || '(toplevel)',
			internal: !file || file === '.runner.uc',
			context: f.context ?? null,
		};
	});

	const type = err.type && err.type !== 'Error' ? err.type : null;
	const message = cleanMessage(err.message, root);
	const own = frames.find((f) => !f.internal);
	const at = message.match(/In line (\d+)(?:, byte (\d+))?/);
	const file = own?.file ?? (step && projectPathOf(step.name, root) ? step.name : null);
	const line = own?.line ?? (at ? Number(at[1]) : null);
	const byte = own?.byte ?? (at?.[2] ? Number(at[2]) : null);
	const text = [
		type ? `${type}: ${message}` : message,
		...frames.slice(0, 6).map((f) => `    at ${f.function} (${f.file ?? '.runner.uc'}:${f.line ?? '?'})`),
	].filter(Boolean).join('\n');

	return { text, type, message, file, line, byte, frames };
}

/**
 * ucode indents compiler diagnostics with "  | ", and paths come back rooted at
 * the pen directory; both make the console harder to read, so flatten them.
 */
function cleanMessage(message, root = PEN_ROOT) {
	return String(message ?? '')
		.split('\n')
		.map((line) => line.replace(/^\s*\|\s?/, ''))
		.join('\n')
		.replaceAll(`${root}/`, '')
		.trim();
}