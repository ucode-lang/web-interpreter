// ucodepen UI.
//
// State is one project object (see project.js); the editor mirrors the current
// file, the worker runs the whole project, and every pane renders from the last
// result. Nothing here touches the wasm module directly -- the run always goes
// through js/runner.js -> js/worker.js -> js/pipeline.js.

import { Editor } from './editor.js';
import { PenRunner } from './runner.js';
import { EXAMPLES, exampleAt } from './examples.js';
import {
	newProject, newFile, kindOf, kindLabel, kindIcon, identKey, validName, manifest,
	encodeShare, decodeShare, serialize, deserialize, loadCurrent, saveCurrent,
	PenStore, newId, baseOf,
} from './project.js';
import { topLevelDecls, hasTopLevelExport } from './scan.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
	const node = document.createElement(tag);

	if (cls)
		node.className = cls;

	if (text != null)
		node.textContent = text;

	return node;
};

const AUTOSAVE_MS = 400;
const AUTORUN_MS = 700;

const state = {
	project: null,
	current: null,
	result: null,
	pane: 'preview',
	outputIndex: 0,
	penId: null,
	running: false,
	queued: false,
};

const store = new PenStore();
let editor = null;
let runner = null;
let booted = false;
let autosaveTimer = null;
let autorunTimer = null;

// ---------------------------------------------------------------------------
// project helpers
// ---------------------------------------------------------------------------

function fileIndex(name) {
	return state.project.files.findIndex((f) => f.name === name);
}

function currentFile() {
	const i = fileIndex(state.current);

	return i < 0 ? null : state.project.files[i];
}

function languageOf(name) {
	switch (kindOf(name)) {
	case 'script': return 'ucode';
	case 'template': return 'template';
	case 'json': return 'json';
	case 'data': return extOfSafe(name) === 'csv' || extOfSafe(name) === 'tsv' ? 'csv' : 'text';
	default: return 'text';
	}
}

function extOfSafe(name) {
	const base = baseOf(name);
	const dot = base.lastIndexOf('.');

	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function fileNote(file) {
	if (!file)
		return '';

	const kind = kindOf(file.name);
	const key = identKey(file.name);

	if (kind === 'script') {
		if (hasTopLevelExport(file.content))
			return `module · import { … } from "${key}"`;

		const names = topLevelDecls(file.content);

		return names.length
			? `runs in order · shares ${names.slice(0, 6).join(', ')}${names.length > 6 ? `, +${names.length - 6}` : ''}`
			: 'runs in order';
	}

	if (kind === 'template')
		return 'rendered in template mode against the pen scope';

	if (kind === 'json')
		return `parsed as JSON · DATA.${key}`;

	if (extOfSafe(file.name) === 'csv' || extOfSafe(file.name) === 'tsv')
		return `tabulated rows · DATA.${key}`;

	return `plain text · DATA.${key} · PEN.raw.${key} · PEN.lines.${key}`;
}

// ---------------------------------------------------------------------------
// rendering: file rail + editor
// ---------------------------------------------------------------------------

function renderRail() {
	const list = $('#filelist');

	list.replaceChildren();

	for (const file of state.project.files) {
		const li = el('li');
		const kind = kindOf(file.name);
		const failed = state.result?.steps?.find((s) => s.name === file.name && !s.ok);

		li.classList.toggle('active', file.name === state.current);
		li.classList.toggle('bad', !!failed);
		li.title = failed ? `last run failed: ${failed.error?.text?.split('\n')[0] ?? 'error'}` : file.name;

		li.append(el('span', 'ic', failed ? '!' : kindIcon(kind)));
		li.append(el('span', 'nm', file.name));

		if (kind === 'script' && hasTopLevelExport(file.content))
			li.append(el('span', 'mod', 'mod'));

		const del = el('button', 'x', '\u00d7');

		del.title = 'delete file';
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			deleteFile(file.name);
		});
		li.append(del);

		li.addEventListener('click', () => openFile(file.name));
		li.addEventListener('dblclick', (e) => {
			e.preventDefault();
			renameFile(file.name);
		});

		list.append(li);
	}
}

function renderEditorHead() {
	const file = currentFile();

	$('#file-kind').textContent = file ? kindLabel(kindOf(file.name)) : '';
	$('#file-note').textContent = file ? fileNote(file) : '';
	updateCursor();
}

function updateCursor() {
	$('#cursor').textContent = editor && fileIndex(state.current) >= 0
		? `Ln ${editor.cursorLine}, Col ${editor.cursorColumn}`
		: '';
}

function openFile(name) {
	if (fileIndex(name) < 0) {
		state.current = state.project.files[0]?.name ?? null;

		if (!state.current)
			return;
	}
	else {
		state.current = name;
	}

	const file = currentFile();

	editor.setLanguage(languageOf(name));
	editor.setValue(file?.content ?? '');
	editor.setError(null);
	renderRail();
	renderEditorHead();
	editor.focus();
}

function addFile(suggested) {
	// The initial pen is restored asynchronously, so the toolbar can be
	// clicked before there is a project to add to.
	if (!state.project)
		return;

	const name = (suggested ?? window.prompt(
		'New file name.\n\n.uc script · .ut template · .json / .csv / .txt data',
		nextDefaultName()))?.trim();

	if (!name)
		return;

	const problem = validName(name);

	if (problem) {
		toast(`Bad file name: ${problem}`, 'err');

		return;
	}

	if (fileIndex(name) >= 0) {
		openFile(name);

		return;
	}

	state.project.files.push(newFile(name, starterFor(name)));
	openFile(name);
	touch();
}

function starterFor(name) {
	const key = identKey(name);

	switch (kindOf(name)) {
	case 'script':
		return `// ${name} -- runs before the templates.\n// Top level names here are visible in every .ut file.\n// print(...) writes to the console pane; ucode needs ";" between statements.\n\nlet greeting = "hello from ${name}";\n`;
	case 'template':
		return `Hello {{ greeting }}\n\n{% for (let i = 0; i < 3; i = i + 1): %}\nline {{ i }}\n{% endfor %}\n`;
	case 'json':
		return '{\n  \n}\n';
	default:
		return '';
	}
}

function nextDefaultName() {
	const n = state.project.files.length + 1;

	return state.project.files.some((f) => kindOf(f.name) === 'template') ? `file${n}.uc` : 'main.uc';
}

function renameFile(name) {
	const to = window.prompt('Rename file', name)?.trim();

	if (!to || to === name)
		return;

	if (validName(to)) {
		toast(`Bad file name: ${validName(to)}`, 'err');

		return;
	}

	if (fileIndex(to) >= 0) {
		toast(`${to} already exists`, 'err');

		return;
	}

	state.project.files[fileIndex(name)].name = to;

	if (state.current === name)
		state.current = to;

	openFile(to);
	touch();
}

function deleteFile(name) {
	const i = fileIndex(name);

	if (i < 0)
		return;

	if (!window.confirm(`Delete ${name}?`))
		return;

	state.project.files.splice(i, 1);
	openFile(state.project.files[Math.max(0, i - 1)]?.name ?? null);
	touch();
}

// ---------------------------------------------------------------------------
// rendering: result panes
// ---------------------------------------------------------------------------

function renderResult(result) {
	state.result = result;

	renderRail();
	renderStatus();
	renderOutput();
	renderPreview();
	renderData();
	renderFilesPane();

	// Underline the offending lines of the file being edited, but never move the
	// caret or switch files from here: an autorun fires while the user is still
	// typing, and yanking the cursor to the error line is what they least want.
	// Moving around stays reserved for jumpTo(), driven by clicking an error.
	editor.setError(errorMarks());
}

/** Wavy-underlay positions for every failing step in the file being edited. */
function errorMarks() {
	const lines = editor.getValue().split('\n');

	return (state.result?.steps ?? [])
		.filter((s) => !s.ok && s.error?.line && (s.error.file ?? s.name) === state.current)
		.map((s) => markFor(s.name, s.kind, s.error))
		.filter((m) => m.line <= lines.length);
}

/** One mark, carrying enough detail for the hover tooltip. */
function markFor(name, kind, error) {
	return {
		line: error.line,
		column: error.byte ?? 1,
		type: error.type ?? 'Error',
		label: `${kind} ${name}`,
		where: `${error.file ?? name}:${error.line}${error.byte ? `:${error.byte}` : ''}`,
		message: firstLine(error.message ?? error.text),
		detail: error.message ?? error.text,
	};
}

const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

function renderStatus() {
	const status = $('#status');
	const result = state.result;

	status.classList.remove('ok', 'err', 'busy');

	if (state.running) {
		status.textContent = 'running\u2026';
		status.classList.add('busy');

		return;
	}

	if (!result) {
		status.textContent = 'not run yet';

		return;
	}

	if (result.timeout) {
		status.textContent = `stopped after ${result.ms} ms -- endless loop? (ucode turns tail recursion into a jump)`;
		status.classList.add('err');

		return;
	}

	const parts = [result.ok ? 'ok' : 'failed', `${result.ms} ms`];

	if (result.outputs?.length)
		parts.push(`${result.outputs.length} output${result.outputs.length > 1 ? 's' : ''}`);

	if (result.steps?.length)
		parts.push(`${result.steps.length} step${result.steps.length === 1 ? '' : 's'}`);

	status.textContent = parts.join(' \u00b7 ');
	status.classList.add(result.ok ? 'ok' : 'err');
}

function selectedOutput() {
	const outputs = state.result?.outputs ?? [];

	if (!outputs.length)
		return null;

	state.outputIndex = Math.max(0, Math.min(state.outputIndex, outputs.length - 1));

	return outputs[state.outputIndex];
}

function renderPreview() {
	const frame = $('#preview');
	const text = $('#preview-text');
	const select = $('#output-select');
	const out = selectedOutput();
	const outputs = state.result?.outputs ?? [];

	select.hidden = outputs.length < 2;
	select.replaceChildren(...outputs.map((o, i) => {
		const opt = el('option', null, `${o.name} (${o.bytes} B)`);

		opt.value = String(i);
		opt.selected = i === state.outputIndex;

		return opt;
	}));

	if (!out) {
		frame.hidden = true;
		text.hidden = false;
		text.textContent = state.result
			? 'No rendered output. Add a .ut template, or call pen.out(name, body) from a script.'
			: '';

		return;
	}

	if (out.html) {
		frame.hidden = false;
		text.hidden = true;
		frame.srcdoc = out.text;
	}
	else {
		frame.hidden = true;
		text.hidden = false;
		text.textContent = out.text;
	}
}

function renderOutput() {
	const steps = $('#steps');
	const console_ = $('#console');

	steps.replaceChildren();

	for (const step of state.result?.steps ?? []) {
		const chip = el('span', `step ${step.ok ? 'ok' : 'fail'}`);

		chip.append(el('span', 'k', step.kind));
		chip.append(el('span', null, step.name));
		chip.append(el('span', 'k', `${Math.round(step.ms)}ms`));

		if (!step.ok) {
			chip.title = 'jump to the error';
			chip.addEventListener('click', () => jumpTo(step.error));
		}

		steps.append(chip);
	}

	console_.replaceChildren();

	if (state.result?.timeout) {
		const p = el('div', 'err', `The run was killed after ${state.result.ms} ms. ucode compiles tail calls into jumps, so `
			+ '`function f(n){ return f(n+1) }` loops forever instead of overflowing the stack.');

		console_.append(p);
	}

	const failed = (state.result?.steps ?? []).filter((s) => !s.ok);

	for (const step of failed.slice(0, 5))
		console_.append(errorBlock(step));

	if (state.result?.error && !failed.length)
		console_.append(errorBlock({ kind: 'runner', name: 'runner', error: { text: state.result.error, message: state.result.error, frames: [] } }));

	if (state.result?.console) {
		const pre = el('div', null, state.result.console);

		pre.style.whiteSpace = 'pre-wrap';
		console_.append(el('div', 'hint', '\u2500 stdout \u2500'.padEnd(60, '\u2500')));
		console_.append(pre);
	}

	if (state.result?.stderr) {
		const pre = el('div', null, state.result.stderr);

		pre.style.whiteSpace = 'pre-wrap';
		console_.append(el('div', 'hint', '\u2500 stderr \u2500'.padEnd(60, '\u2500')));
		console_.append(pre);
	}

	if (!state.result?.error && !state.result?.console && !state.result?.stderr && !state.result?.timeout && state.result)
		console_.append(el('div', 'hint', 'The scripts printed nothing (remember: print() does not add newlines, pass "\\n").'));
}

/*
 * One failing step, rendered as much as is known about it: what kind of error,
 * which file and position, the message, and the stack frames underneath. Every
 * position is a link into the editor.
 */
function errorBlock(step) {
	const error = step.error ?? { message: String(step), frames: [] };
	const wrap = el('div', 'errblock');
	const head = el('div', 'errhead');

	if (error.type)
		head.append(el('span', 'errtype', error.type));

	head.append(el('span', 'errwhere', `${step.kind} ${step.name}`));

	if (error.file && error.line)
		head.append(errorLink(error.file, error.line, error.byte));

	wrap.append(head);

	const body = el('pre', 'errmsg');

	for (const chunk of messageChunks(error.message ?? error.text ?? '', error)) {
		if (chunk.jump)
			body.append(errorLink(error.file ?? step.name, chunk.jump.line, chunk.jump.byte, chunk.text));
		else
			body.append(chunk.text);
	}

	wrap.append(body);

	const frames = (error.frames ?? []).filter((f) => f.line != null);

	if (frames.length) {
		const more = el('details', 'errmore');

		more.append(el('summary', null, `${frames.length} stack frame${frames.length === 1 ? '' : 's'}`));

		for (const f of frames) {
			const row = el('div', f.internal ? 'frame internal' : 'frame');

			row.append(el('span', 'fn', f.function));

			if (f.file && !f.internal)
				row.append(errorLink(f.file, f.line, f.byte));
			else
				row.append(el('span', 'at', `${f.file ?? '.runner.uc'}:${f.line}`));

			more.append(row);
		}

		wrap.append(more);
	}

	return wrap;
}

function errorLink(file, line, byte, label) {
	const link = el('a', 'errjump', label ?? `${file}:${line}${byte ? `:${byte}` : ''}`);

	link.href = '#';
	link.addEventListener('click', (e) => {
		e.preventDefault();
		jumpTo({ ...error, file, line: Number(line), byte: byte ? Number(byte) : null });
	});

	return link;
}

/** Split a message around "In line N, byte M" so those become clickable. */
function messageChunks(message, error) {
	const out = [];
	const re = /In line (\d+)(?:, byte (\d+))?/g;
	let at = 0, m;

	while ((m = re.exec(message))) {
		if (m.index > at)
			out.push({ text: message.slice(at, m.index) });

		out.push({ text: m[0], jump: { line: Number(m[1]), byte: m[2] ? Number(m[2]) : null } });
		at = m.index + m[0].length;
	}

	if (at < message.length)
		out.push({ text: message.slice(at) });

	if (!out.length && error)
		out.push({ text: message });

	return out;
}

function jumpTo(error) {
	if (!error?.file)
		return;

	if (fileIndex(error.file) < 0) {
		toast(`${error.file} is not a file of this pen`, 'err');

		return;
	}

	if (state.current !== error.file)
		openFile(error.file);

	editor.setError([markFor(error.file, 'error', error)]);
	editor.revealLine(error.line, error.byte ?? 1);
}

function renderData() {
	const host = $('#data-tables');

	host.replaceChildren();

	const inspect = state.result?.inspect;

	if (!inspect) {
		host.append(el('div', null, state.result ? 'No data from the last run.' : 'Run the pen to see what the templates can see.'));

		return;
	}

	host.append(grid('data files (DATA)', ['name', 'type', 'value'], inspect.data ?? []));
	host.append(grid('pen scope', ['name', 'type', 'value', 'where'], inspect.names ?? []));
}

function grid(title, head, rows) {
	const box = el('div');

	box.append(el('h3', null, title));

	if (!rows.length) {
		box.append(el('div', null, '\u2014 nothing yet \u2014'));

		return box;
	}

	const table = el('table', 'grid');
	const tr = document.createElement('tr');

	tr.append(...head.map((h) => el('th', null, h)));
	table.append(tr);

	for (const row of rows) {
		const r = document.createElement('tr');

		r.append(el('td', 'v', row.name));
		r.append(el('td', 't', row.type));
		r.append(el('td', 'v', row.preview));

		if (row.where)
			r.append(el('td', 'w', row.where));

		table.append(r);
	}

	box.append(table);

	return box;
}

function renderFilesPane() {
	const host = $('#files-info');

	host.replaceChildren();

	const man = state.result?.manifest;

	if (!man) {
		host.append(el('div', null, 'Run the pen to see how it maps onto the virtual filesystem.'));

		return;
	}

	const section = (title, items) => {
		host.append(el('h3', null, title));

		if (!items.length) {
			host.append(el('div', 'kv', 'none'));

			return;
		}

		const ul = document.createElement('ul');

		for (const item of items)
			ul.append(el('li', null, item));

		host.append(ul);
	};

	section('scripts (run in order)', man.scripts);
	section('modules (import / require)', man.modules ?? []);
	section('templates (rendered)', man.templates);
	section('data files', man.data.map((d) => `${d.path} \u2192 DATA.${d.key}`));

	host.append(el('h3', null, '/pen in the interpreter'));

	const ul = document.createElement('ul');

	for (const entry of state.result.tree ?? [])
		ul.append(el('li', null, `${entry.path}  (${entry.type === 'dir' ? 'dir' : `${entry.size} B`})`));

	host.append(ul);

	host.append(el('p', 'kv', 'REQUIRE_SEARCH_PATH starts with /pen/*.uc, so a file named lib.uc is reachable as require("lib") or import { x } from "lib".'));
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

async function run({ force = false } = {}) {
	if (state.running) {
		state.queued = true;

		return;
	}

	state.running = true;
	$('#run').disabled = true;
	renderStatus();

	const started = performance.now();
	let result = await runner.run(state.project);

	if (result.timeout)
		result = { ...result, steps: [], outputs: [], console: '', ms: result.ms };

	// keep the reported time honest (the worker measures too)
	result.ms = result.ms ?? Math.round(performance.now() - started);

	state.running = false;
	$('#run').disabled = false;
	renderResult(result);

	if (state.queued || (force && !result.ok)) {
		state.queued = false;
		run();
	}
}

function scheduleRun() {
	if (!$('#autorun').checked)
		return;

	clearTimeout(autorunTimer);
	autorunTimer = setTimeout(() => run(), AUTORUN_MS);
}

function touch() {
	state.project.updated = Date.now();
	renderRail();
	renderEditorHead();

	clearTimeout(autosaveTimer);
	autosaveTimer = setTimeout(() => saveCurrent(state.project), AUTOSAVE_MS);

	scheduleRun();
}

// ---------------------------------------------------------------------------
// menus, sharing, storage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------

function renderUser() {
	const login = $('#login-btn');
	const host = $('#user-host');

	login.hidden = !store.needsLogin;
	host.hidden = !store.user;

	if (store.needsLogin)
		login.href = store.loginUrl();

	if (store.user) {
		$('#user-name').textContent = store.user.login;

		const avatar = $('#user-avatar');

		if (store.user.avatar_url) {
			avatar.src = store.user.avatar_url;
			avatar.hidden = false;
		}
		else {
			avatar.hidden = true;
		}
	}
}

function renderUserMenu() {
	const menu = $('#menu-user');

	menu.replaceChildren(el('h3', null, store.user ? `signed in as ${store.user.login}` : 'account'));

	if (!store.user)
		return;

	const pens = el('button', 'item');

	pens.append(el('b', null, 'your pens'));
	pens.append(el('small', null, 'open the pens menu'));
	pens.addEventListener('click', () => {
		closeMenus();
		renderPensMenu();
		$('[data-menu="pens"]').click();
	});
	menu.append(pens);

	const out = el('button', 'item');
	const back = new URL('../logout', location.href);

	back.search = `next=${encodeURIComponent(location.pathname + location.hash)}`;

	out.append(el('b', null, 'sign out'));
	out.append(el('small', null, 'saved pens stay on the server'));
	out.addEventListener('click', () => { location.href = back.href; });
	menu.append(out);
}

function toast(message, kind = 'ok', ms = 2600) {
	const node = $('#toast');

	node.textContent = message;
	node.className = `toast ${kind}`;
	node.hidden = false;

	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => {
		node.hidden = true;
	}, ms);
}

function closeMenus() {
	for (const menu of document.querySelectorAll('.menu'))
		menu.hidden = true;
}

function buildMenus() {
	const examples = $('#menu-examples');

	examples.replaceChildren(el('h3', null, 'load an example (replaces the current pen)'));

	EXAMPLES.forEach((ex, i) => {
		const btn = el('button', 'item');

		btn.append(el('b', null, ex.name));
		btn.append(el('small', null, ex.description));
		btn.addEventListener('click', () => {
			loadProject(exampleAt(i), { source: `example: ${ex.name}` });
			closeMenus();
		});
		examples.append(btn);
	});

	const share = $('#menu-share');

	share.replaceChildren();

	const item = (label, hint, fn) => {
		const btn = el('button', 'item');

		btn.append(el('b', null, label));

		if (hint)
			btn.append(el('small', null, hint));

		btn.addEventListener('click', fn);

		return btn;
	};

	share.append(el('h3', null, 'share'));
	share.append(item('copy link', 'the whole pen is encoded in the URL fragment', copyShareLink));
	share.append(item('open link in a new tab', null, async () => {
		window.open(await shareLink(), '_blank');
	}));
	share.append(el('h3', null, 'files'));
	share.append(item('download .json', 'portable pen file', downloadPen));
	share.append(item('load .json\u2026', 'or drop a file anywhere on the page', () => $('#import-file').click()));
	share.append(el('h3', null, 'this pen'));
	share.append(item('new empty pen', null, () => {
		loadProject(newProject([['main.uc', starterFor('main.uc')], ['index.ut', starterFor('index.ut')]], 'untitled'), { source: 'new' });
		closeMenus();
	}));
	share.append(item('duplicate as a new pen', null, () => {
		const copy = deserialize(serialize(state.project));

		copy.name = `${copy.name} copy`;
		loadProject(copy, { source: 'duplicate' });
		closeMenus();
	}));
}

async function renderPensMenu() {
	const menu = $('#menu-pens');

	menu.replaceChildren(el('h3', null, store.needsLogin ? 'saved pens (sign in first)' : store.remote ? 'saved pens (server)' : 'saved pens (this browser)'));

	if (store.needsLogin) {
		const signin = el('button', 'item');

		signin.append(el('b', null, 'sign in with GitHub'));
		signin.append(el('small', null, 'pens are stored under your account'));
		signin.addEventListener('click', () => { location.href = store.loginUrl(); });
		menu.append(signin);

		return;
	}

	const save = el('button', 'item');

	save.append(el('b', null, store.penId === state.penId && state.penId ? 'update saved pen' : 'save pen'));
	save.append(el('small', null, state.penId ? `id ${state.penId}` : 'stores it under a short id'));
	save.addEventListener('click', async () => {
		try {
			state.penId = await store.put(state.penId ?? newId(), state.project);
			toast(`saved as ${state.penId} \u2014 link ${location.origin}${location.pathname}#pen=${state.penId}`, 'ok', 5000);
			renderPensMenu();
		}
		catch (err) {
			toast(String(err.message ?? err), 'err');
		}
	});
	menu.append(save);

	let pens = [];

	try {
		pens = await store.list();
	}
	catch (err) {
		menu.append(el('div', 'empty', `could not list pens: ${err.message}`));

		return;
	}

	if (!pens.length) {
		menu.append(el('div', 'empty', 'nothing saved yet'));

		return;
	}

	for (const meta of pens.slice(0, 40)) {
		const btn = el('button', 'item');
		const row = el('div', 'row');

		row.append(el('b', null, meta.name ?? meta.id));
		row.append(el('small', null, `${meta.id} \u00b7 ${new Date(meta.updated).toLocaleString()}`));

		const del = el('button', 'del', '\u00d7');

		del.title = 'delete';
		del.addEventListener('click', async (e) => {
			e.stopPropagation();

			if (!window.confirm(`Delete ${meta.name ?? meta.id}?`))
				return;

			await store.remove(meta.id);
			renderPensMenu();
		});
		row.append(del);

		btn.append(row);
		btn.addEventListener('click', async () => {
			try {
				loadProject(await store.get(meta.id), { source: `saved: ${meta.id}`, id: meta.id });
				closeMenus();
			}
			catch (err) {
				toast(String(err.message ?? err), 'err');
			}
		});

		menu.append(btn);
	}
}

async function shareLink() {
	// A pen that already lives on the server shares through its short, stable
	// link; anything else has to travel inside the URL fragment.
	if (state.penId && store.remote)
		return `${location.origin}/p/${state.penId}`;

	return `${location.origin}${location.pathname}#p=${await encodeShare(state.project)}`;
}

async function copyShareLink() {
	const link = await shareLink();
	const hash = link.lastIndexOf('#');

	try {
		await navigator.clipboard.writeText(link);
		toast('link copied to the clipboard', 'ok');
	}
	catch (err) {
		toast(`copy failed (${err.message}) \u2014 the link is in the address bar`, 'err', 5000);
	}

	// make that message true even without clipboard permission
	if (hash >= 0)
		history.replaceState(null, '', link.slice(hash));
}

function downloadPen() {
	const blob = new Blob([JSON.stringify(serialize(state.project), null, '\t')], { type: 'application/json' });
	const a = document.createElement('a');

	a.href = URL.createObjectURL(blob);
	a.download = `${(state.project.name || 'pen').replace(/[^\w.-]+/g, '_')}.ucodepen.json`;
	a.click();
	URL.revokeObjectURL(a.href);
}

async function importFile(file) {
	try {
		loadProject(deserialize(JSON.parse(await file.text())), { source: `file: ${file.name}` });
		toast(`loaded ${file.name}`);
	}
	catch (err) {
		toast(`could not load ${file.name}: ${err.message}`, 'err');
	}
}

// ---------------------------------------------------------------------------
// project loading
// ---------------------------------------------------------------------------

function loadProject(project, { source = '', id = null } = {}) {
	state.project = project;
	state.penId = id;
	state.result = null;
	state.outputIndex = 0;

	$('#pen-name').value = project.name ?? 'untitled';

	const first = project.files.find((f) => kindOf(f.name) === 'script') ?? project.files[0];

	openFile(first?.name ?? null);
	saveCurrent(project);
	renderResult({ ok: true, steps: [], outputs: [], console: '', ms: 0, manifest: manifest(project) });
	state.result = null;
	renderStatus();
	run();

	if (source)
		toast(`${source} \u2014 ${project.files.length} file${project.files.length === 1 ? '' : 's'}`);
}

async function initialProject() {
	const hash = location.hash || '';

	if (hash.startsWith('#p=')) {
		try {
			return { project: await decodeShare(hash.slice(3)), source: 'shared link' };
		}
		catch (err) {
			toast(`could not decode the shared pen (${err.message})`, 'err', 5000);
		}
	}

	const id = hash.startsWith('#pen=') ? hash.slice(5) : new URLSearchParams(location.search).get('pen');

	if (id) {
		try {
			await store.detect();

			return { project: await store.get(id), source: `pen ${id}`, id };
		}
		catch (err) {
			toast(`could not load pen ${id} (${err.message})`, 'err', 5000);
		}
	}

	const saved = loadCurrent();

	if (saved?.files?.length)
		return { project: saved, source: 'restored from this browser' };

	return { project: exampleAt(1), source: 'example' };
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function wireMenus() {
	for (const btn of document.querySelectorAll('[data-menu]')) {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();

			const menu = $(`#menu-${btn.dataset.menu}`);
			const wasHidden = menu.hidden;

			closeMenus();

			if (wasHidden) {
				menu.hidden = false;

				if (btn.dataset.menu === 'pens')
					renderPensMenu();

				if (btn.dataset.menu === 'user')
					renderUserMenu();
			}
		});
	}

	document.addEventListener('click', closeMenus);
	for (const menu of document.querySelectorAll('.menu'))
		menu.addEventListener('click', (e) => e.stopPropagation());
}

function wireSplitter() {
	const handle = $('#splitter');
	const work = $('.work');
	let dragging = false;

	const set = (clientY) => {
		const rect = work.getBoundingClientRect();
		const pct = 100 - ((clientY - rect.top) / rect.height) * 100;

		document.documentElement.style.setProperty('--results', `${Math.min(85, Math.max(12, pct))}%`);
	};

	handle.addEventListener('pointerdown', (e) => {
		dragging = true;

		try {
			handle.setPointerCapture(e.pointerId);
		}
		catch {
			// synthetic pointer events have no capture to take
		}
	});

	handle.addEventListener('pointermove', (e) => {
		if (dragging)
			set(e.clientY);
	});

	handle.addEventListener('pointerup', (e) => {
		dragging = false;

		try {
			handle.releasePointerCapture(e.pointerId);
		}
		catch {
			// see above
		}
	});
}

function wirePanes() {
	for (const tab of document.querySelectorAll('.tab')) {
		tab.addEventListener('click', () => {
			state.pane = tab.dataset.pane;

			for (const other of document.querySelectorAll('.tab'))
				other.classList.toggle('active', other === tab);

			for (const pane of document.querySelectorAll('.pane'))
				pane.hidden = pane.id !== `pane-${state.pane}`;
		});
	}

	$('#output-select').addEventListener('change', (e) => {
		state.outputIndex = Number(e.target.value) || 0;
		renderPreview();
	});
}

function wireGlobalKeys() {
	window.addEventListener('keydown', (e) => {
		const mod = e.ctrlKey || e.metaKey;

		if (mod && e.key === 'Enter') {
			e.preventDefault();
			run({ force: true });
		}
		else if (mod && (e.key === 's' || e.key === 'S')) {
			e.preventDefault();
			saveCurrent(state.project);
			toast('saved in this browser (use share \u2192 copy link to share)');
		}
		else if (mod && /^[1-9]$/.test(e.key)) {
			const file = state.project.files[Number(e.key) - 1];

			if (file) {
				e.preventDefault();
				openFile(file.name);
			}
		}
		else if (e.key === 'Escape') {
			closeMenus();
		}
	});
}

function wireFiles() {
	$('#add-file').addEventListener('click', () => addFile());
	$('#run').addEventListener('click', () => run({ force: true }));
	$('#autorun').addEventListener('change', () => {
		if ($('#autorun').checked)
			scheduleRun();
	});
	$('#timeout').addEventListener('change', (e) => {
		runner.timeoutMs = Number(e.target.value);
		toast(`runs are killed after ${e.target.value / 1000}s`);
	});

	$('#pen-name').addEventListener('input', (e) => {
		state.project.name = e.target.value || 'untitled';
		touch();
	});

	$('#import-file').addEventListener('change', (e) => {
		const file = e.target.files?.[0];

		if (file)
			importFile(file);

		e.target.value = '';
	});

	window.addEventListener('dragover', (e) => {
		e.preventDefault();
		$('#drop').hidden = false;
	});

	window.addEventListener('dragleave', (e) => {
		if (!e.relatedTarget)
			$('#drop').hidden = true;
	});

	window.addEventListener('drop', (e) => {
		e.preventDefault();
		$('#drop').hidden = true;

		const file = e.dataTransfer?.files?.[0];

		if (file)
			importFile(file);
	});

	window.addEventListener('hashchange', async () => {
		const next = await initialProject();

		loadProject(next.project, { source: next.source, id: next.id });
	});
}

async function main() {
	editor = new Editor($('#editor'), {
		language: 'ucode',
		onChange: () => {
			const file = currentFile();

			if (file) {
				const value = editor.getValue();

				if (value !== file.content) {
					file.content = value;
					touch();
				}
			}

			updateCursor();
		},
		onRun: () => run({ force: true }),
		onSave: () => {
			saveCurrent(state.project);
			toast('saved in this browser');
		},
	});

	runner = new PenRunner('js/worker.js', {
		timeoutMs: Number($('#timeout').value),
		onready: ({ modules }) => {
			// Only announce the very first boot: after a run gets killed the
			// worker is respawned, and its readiness must not overwrite the
			// "stopped after N ms" status the user needs to see.
			if (booted)
				return;

			booted = true;
			$('#status').textContent = `wasm ready \u00b7 ${modules} modules linked`;
		},
	});

	buildMenus();
	wireMenus();
	wirePanes();
	wireSplitter();
	wireGlobalKeys();
	wireFiles();

	await store.detect();
	renderUser();

	const next = await initialProject();

	loadProject(next.project, { source: next.source, id: next.id });
}

main().catch((err) => {
	console.error(err);
	toast(`startup failed: ${err.message}`, 'err', 10000);
});