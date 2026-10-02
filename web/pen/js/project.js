// The pen model: what a project is, how its files are classified, how it turns
// into a runner manifest, and how it is stored and shared.
//
// A pen is a flat list of named files -- the ucode equivalents of CodePen's
// three panes:
//
//   .uc    script       raw ucode, executed in order, one shared scope
//   .ut    template     ucode template mode, rendered against that scope
//   .json  data         parsed JSON, reachable as DATA.<name>
//   .csv   data         tabulated into an array of row objects
//   .txt   data         plain ASCII text, as DATA.<name> / PEN.lines.<name>
//
// Everything else (.md, .yaml, .sql, no extension, ...) counts as plain text
// data too, so a pen can carry whatever input its script needs.

import { hasTopLevelExport } from './scan.js';

export const SCRIPT_EXT = 'uc';
export const TEMPLATE_EXT = 'ut';
/** Extensions that render as output documents instead of being data. */
export const OUTPUT_EXTS = ['conf', 'ini', 'yaml', 'yml', 'toml', 'md'];

export function extOf(path) {
	const base = baseOf(path);
	const dot = base.lastIndexOf('.');

	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function baseOf(path) {
	const parts = String(path || '').split('/');

	return parts[parts.length - 1];
}

/** 'script' | 'template' | 'json' | 'data' */
export function kindOf(path) {
	const ext = extOf(path);

	if (ext === SCRIPT_EXT)
		return 'script';

	if (ext === TEMPLATE_EXT)
		return 'template';

	if (ext === 'json')
		return 'json';

	if (OUTPUT_EXTS.includes(ext))
		return 'template';

	return 'data';
}

export function kindLabel(kind) {
	return { script: 'script', template: 'template', json: 'json data', data: 'text data' }[kind] || kind;
}

export function kindIcon(kind) {
	return { script: 'λ', template: '◈', json: '{ }', data: '≡' }[kind] || '·';
}

/** Mirror of ident() in runner.uc: "My Data.json" -> "my_data". */
export function identKey(path) {
	const base = baseOf(path);
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	let out = stem.toLowerCase().replace(/[^a-z0-9_]/g, '_');

	if (/^[0-9]/.test(out))
		out = '_' + out;

	return out || '_';
}

/** Reject paths that would escape /pen/ or confuse the tabs. */
export function validName(name) {
	if (!name || !name.trim())
		return 'empty name';

	if (!/^[\w][\w. -]*$/.test(name))
		return 'letters, digits, space, dot, dash, underscore';

	if (name.includes('..') || name.startsWith('/'))
		return 'no leading slash or ".."';

	if (name.length > 96)
		return 'name too long';

	return null;
}

export function newFile(name, content = '') {
	return { name, content };
}

export function newProject(files = [], name = 'untitled') {
	return {
		name,
		files: files.map(([n, c]) => newFile(n, c)),
		updated: Date.now(),
	};
}

/**
 * The manifest runner.uc reads. Paths are relative to /pen/.
 *
 * A .uc file that exports something is a module rather than a script: it is
 * mirrored into /pen/ (and so reachable through require("name") / import, see
 * the /pen/*.uc entry of REQUIRE_SEARCH_PATH) but not executed -- ucode
 * rejects `export` in a plain program.
 */
export function manifest(project) {
	const files = [], scripts = [], templates = [], data = [], modules = [];
	const seen = new Set();

	for (const f of project.files) {
		const name = (f.name || '').replace(/^\/+/, '');

		if (!name || seen.has(name))
			continue;

		seen.add(name);

		const kind = kindOf(name);
		const isModule = kind === 'script' && hasTopLevelExport(f.content ?? '');

		files.push({ path: name, kind, key: identKey(name), module: isModule });

		if (kind === 'script') {
			if (isModule)
				modules.push(name);
			else
				scripts.push(name);
		}
		else if (kind === 'template')
			templates.push(name);
		else
			data.push({ path: name, key: identKey(name) });
	}

	return { name: project.name || 'untitled', files, scripts, templates, data, modules };
}

/** Files whose content is mirrored into /pen/ before a run. */
export function projectFiles(project) {
	const out = [];
	const seen = new Set();

	for (const f of project.files) {
		const name = (f.name || '').replace(/^\/+/, '');

		if (!name || seen.has(name) || validName(name))
			continue;

		seen.add(name);
		out.push({ path: name, kind: kindOf(name), content: f.content ?? '', key: identKey(name) });
	}

	return out;
}

// ---------------------------------------------------------------------------
// sharing: the whole project lives in the URL fragment
// ---------------------------------------------------------------------------

function bytesToB64url(bytes) {
	let bin = '';

	for (let i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));

	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
	const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(bin.length);

	for (let i = 0; i < bin.length; i++)
		bytes[i] = bin.charCodeAt(i);

	return bytes;
}

async function deflate(bytes) {
	if (typeof CompressionStream !== 'function')
		return null;

	const cs = new CompressionStream('deflate-raw');
	const stream = new Blob([bytes]).stream().pipeThrough(cs);

	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
	if (typeof DecompressionStream !== 'function')
		return null;

	const ds = new DecompressionStream('deflate-raw');
	const stream = new Blob([bytes]).stream().pipeThrough(ds);

	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Compact, URL safe encoding of a project (deflate when available). */
export async function encodeShare(project) {
	const json = JSON.stringify(serialize(project));
	const bytes = new TextEncoder().encode(json);
	const zipped = await deflate(bytes);

	if (zipped && zipped.length < bytes.length)
		return 'z1' + bytesToB64url(zipped);

	return 'j1' + bytesToB64url(bytes);
}

export async function decodeShare(token) {
	const body = String(token || '');
	const bytes = b64urlToBytes(body.slice(2));
	let json;

	if (body.startsWith('z1')) {
		const raw = await inflate(bytes);

		if (!raw)
			throw new Error('this browser cannot decompress shared pens');

		json = new TextDecoder().decode(raw);
	}
	else {
		json = new TextDecoder().decode(bytes);
	}

	return deserialize(JSON.parse(json));
}

/** Plain JSON form (used for #hash sharing, files and the server). */
export function serialize(project) {
	return {
		v: 1,
		name: project.name || 'untitled',
		files: projectFiles(project).map((f) => ({ name: f.path, content: f.content })),
	};
}

export function deserialize(obj) {
	if (!obj || !Array.isArray(obj.files))
		throw new Error('not a ucodepen project');

	return newProject(obj.files.map((f) => [f.name, f.content ?? '']), obj.name || 'untitled');
}

// ---------------------------------------------------------------------------
// storage: localStorage by default, the bundled server when one is reachable
// ---------------------------------------------------------------------------

const LIB_KEY = 'ucodepen.library.v1';
const CUR_KEY = 'ucodepen.current.v1';

export function loadCurrent() {
	try {
		const raw = localStorage.getItem(CUR_KEY);

		return raw ? deserialize(JSON.parse(raw)) : null;
	}
	catch {
		return null;
	}
}

export function saveCurrent(project) {
	try {
		localStorage.setItem(CUR_KEY, JSON.stringify(serialize(project)));
	}
	catch {
		/* private mode / quota -- autosave is a nicety, not a feature */
	}
}

export function loadLibrary() {
	try {
		const raw = localStorage.getItem(LIB_KEY);
		const list = raw ? JSON.parse(raw) : [];

		return Array.isArray(list) ? list : [];
	}
	catch {
		return [];
	}
}

export function saveLibrary(list) {
	try {
		localStorage.setItem(LIB_KEY, JSON.stringify(list.slice(0, 200)));
	}
	catch {
		/* ignore */
	}
}

export function newId() {
	return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// The page is served from <root>/pen/, so the API of the bundled server lives
// at <root>/api/. Resolving against the document URL keeps this working no
// matter which prefix the app is mounted under; when no such endpoint exists
// (plain static hosting, file://) PenStore falls back to localStorage.
// Resolved lazily: this module is also imported by the node test runner,
// where there is no `location`.
function apiUrl(id) {
	const base = new URL('../api/pens', location.href).href;

	return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
}

/**
 * Pen store. Uses the bundled server's /api/pens when it answers, so pens get
 * stable short links; otherwise everything stays in localStorage.
 *
 * The server also reports the auth mode (/api/me): 'github' means pens live
 * behind a GitHub login, 'local' is the no-login development mode.
 */
export class PenStore {
	constructor() {
		this.remote = null;
		this.mode = 'local';
		this.user = null;
	}

	get needsLogin() {
		return this.remote && this.mode === 'github' && !this.user;
	}

	/** Where a sign-in link should point; returns to this exact view. */
	loginUrl() {
		const next = location.pathname + location.search + location.hash;
		const back = new URL('../login', location.href);

		back.search = `next=${encodeURIComponent(next)}`;

		return back.href;
	}

	async detect() {
		try {
			const res = await fetch(new URL('../api/me', location.href).href);

			if (res.ok) {
				const me = await res.json();

				this.remote = me.store === 'server';
				this.mode = me.mode ?? 'local';
				this.user = me.user ?? null;
			}
			else {
				this.remote = false;
			}
		}
		catch {
			this.remote = false;
		}

		if (!this.remote)
			this.mode = 'local';

		return this.remote;
	}

	async list() {
		if (this.remote) {
			const res = await fetch(apiUrl());

			// signed out on a github-mode server: nothing to list
			if (res.status === 401)
				return [];

			return (await res.json()).pens.map((p) => ({ ...p, source: 'server' }));
		}

		return loadLibrary().map((p) => ({ id: p.id, name: p.name, updated: p.updated, source: 'local' }));
	}

	async get(id) {
		if (this.remote) {
			const res = await fetch(apiUrl(id));

			if (!res.ok)
				throw new Error(`no pen ${id} on the server`);

			return deserialize(await res.json());
		}

		const entry = loadLibrary().find((p) => p.id === id);

		if (!entry)
			throw new Error(`no pen ${id} in this browser`);

		return deserialize(entry);
	}

	async put(id, project) {
		const payload = serialize(project);

		if (this.remote) {
			const res = await fetch(apiUrl(id), {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});

			if (res.status === 401)
				throw new Error('sign in to save pens on the server');

			if (res.status === 403)
				throw new Error('this pen belongs to another user -- use share > duplicate as a new pen');

			if (!res.ok)
				throw new Error(`server refused the save (${res.status})`);

			return id;
		}

		const list = loadLibrary();
		const entry = { id, name: payload.name, updated: Date.now(), files: payload.files };
		const at = list.findIndex((p) => p.id === id);

		if (at >= 0)
			list[at] = entry;
		else
			list.unshift(entry);

		saveLibrary(list);

		return id;
	}

	async remove(id) {
		if (this.remote) {
			await fetch(apiUrl(id), { method: 'DELETE' });

			return;
		}

		saveLibrary(loadLibrary().filter((p) => p.id !== id));
	}
}