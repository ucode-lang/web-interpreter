// Integration tests for the ucodepen server: auth modes, the GitHub OAuth
// flow (against a stub), pen ownership, and the Postgres store.
//
//   node test/server.mjs                       # file store, no database
//   TEST_PG_URL=postgres://... node test/server.mjs   # also exercises Postgres
//
// The GitHub side is a stub server started here; GITHUB_WEB_BASE /
// GITHUB_API_BASE point the real server at it, so the whole login flow runs
// without touching github.com.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0, failed = 0;

function check(name, cond, detail = '') {
	if (cond) {
		passed++;
		console.log(`  ok   ${name}`);
	}
	else {
		failed++;
		console.log(`  FAIL ${name}${detail ? `\n         ${String(detail).slice(0, 400)}` : ''}`);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the github stub
// ---------------------------------------------------------------------------

function startGithubStub() {
	// code -> profile; membership 404s when rejectOrg is true
	const state = { rejectOrg: false, codes: new Map() };

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://stub');

		if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
			let body = '';
			req.on('data', (c) => body += c);
			req.on('end', () => {
				const code = new URLSearchParams(body).get('code');
				const profile = state.codes.get(code);

				res.writeHead(profile ? 200 : 400, { 'content-type': 'application/json' });
				res.end(JSON.stringify(profile
					? { access_token: `token-for-${code}`, token_type: 'bearer' }
					: { error: 'bad_verification_code' }));
			});
			return;
		}

		if (url.pathname === '/user') {
			const token = (req.headers.authorization || '').replace('Bearer token-for-', '');
			const profile = state.codes.get(token);

			res.writeHead(profile ? 200 : 401, { 'content-type': 'application/json' });
			res.end(JSON.stringify(profile ?? { message: 'Bad credentials' }));
			return;
		}

		if (url.pathname.startsWith('/user/memberships/orgs/')) {
			const token = (req.headers.authorization || '').replace('Bearer token-for-', '');

			if (state.rejectOrg || !state.codes.get(token)) {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ message: 'Not Found' }));
			}
			else {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ state: 'active', organization: { login: 'ucode-lang' } }));
			}
			return;
		}

		res.writeHead(404);
		res.end('no such github route');
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve({
			base: `http://127.0.0.1:${server.address().port}`,
			state,
			close: () => server.close(),
		}));
	});
}

// ---------------------------------------------------------------------------
// the server under test
// ---------------------------------------------------------------------------

function startServer(port, env) {
	const child = spawn('python3', ['-m', 'server', String(port)], {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let log = '';
	child.stderr.on('data', (d) => log += d);
	child.stdout.on('data', (d) => log += d);

	return { child, log: () => log };
}

async function waitReady(port, tries = 50) {
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/me`);
			if (res.ok) return;
		}
		catch { /* not up yet */ }

		await sleep(120);
	}

	throw new Error('server did not come up');
}

// a tiny cookie jar: enough for redirects + session cookies
class Jar {
	cookies = {};

	absorb(res) {
		for (const cookie of res.headers.getSetCookie?.() ?? []) {
			const pair = cookie.split(';')[0];
			const at = pair.indexOf('=');
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1);

			if (value === '' || /Max-Age=0\b/.test(cookie))
				delete this.cookies[name];
			else
				this.cookies[name] = value;
		}
	}

	header() {
		return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
	}

	names() {
		return Object.keys(this.cookies);
	}
}

const call = async (port, path, { method = 'GET', body, jar } = {}) => {
	const headers = {};

	if (jar?.header())
		headers.cookie = jar.header();

	if (body)
		headers['content-type'] = 'application/json';

	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method, headers, body: body ? JSON.stringify(body) : undefined,
		redirect: 'manual',
	});

	jar?.absorb(res);

	return res;
};

const penDoc = (name = 'test pen') => ({
	name,
	files: [{ name: 'main.uc', content: 'print("hi");' }, { name: 'index.ut', content: '<p>{{ 1 }}</p>' }],
});

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const stub = await startGithubStub();
const servers = [];

async function boot(name, env) {
	const port = 8700 + servers.length;
	const pens = mkdtempSync(join(tmpdir(), `ucodepen-${name}-`));
	const handle = startServer(port, {
		PENS_DIR: pens,
		...env,
	});
	servers.push(handle);
	await waitReady(port);

	return { port, pens };
}

const text = async (res) => await res.text();
const json = async (res) => JSON.parse(await res.text());

// -- 1. local mode ----------------------------------------------------------

console.log('local mode (no credentials configured)');
{
	const { port } = await boot('local', {});

	const me = await json(await call(port, '/api/me'));
	check('/api/me reports local mode', me.mode === 'local' && me.store === 'server' && me.authenticated === false, JSON.stringify(me));

	const put = await call(port, '/api/pens/abc123', { method: 'PUT', body: penDoc() });
	check('saving works without login', put.ok, await text(put));

	const list = await json(await call(port, '/api/pens'));
	check('listing works without login', Array.isArray(list.pens) && list.pens.length === 1, JSON.stringify(list));

	const login = await call(port, '/login');
	check('/login just bounces back in local mode', login.status === 302 && login.headers.get('location') === '/pen/');

	const run = await call(port, '/run/3%20*%205');
	check('/run/<code> redirects to the repl with #code=', run.status === 302 && run.headers.get('location') === '/#code=3%20*%205', `${run.status} ${run.headers.get('location')}`);

	const runQuoted = await call(port, '/run/print(%27hi%27)');
	check('/run/<code> keeps fragment-legal characters raw', runQuoted.status === 302 && runQuoted.headers.get('location') === "/#code=print('hi')", runQuoted.headers.get('location'));

	const runHash = await call(port, '/run/a%23b');
	check('/run/<code> always encodes # so it cannot truncate the fragment', runHash.status === 302 && runHash.headers.get('location') === '/#code=a%23b', runHash.headers.get('location'));

	const runEmpty = await call(port, '/run/');
	check('/run/ without code is rejected', runEmpty.status === 400);
}

// -- 2. github mode, unauthenticated ----------------------------------------

console.log('github mode, not signed in');
{
	const { port } = await boot('gh', {
		GITHUB_CLIENT_ID: 'test-client',
		GITHUB_CLIENT_SECRET: 'test-secret',
		SECRET_KEY: 'test-secret-key',
		GITHUB_WEB_BASE: stub.base,
		GITHUB_API_BASE: stub.base,
	});

	const me = await json(await call(port, '/api/me'));
	check('/api/me reports github mode, signed out', me.mode === 'github' && me.authenticated === false, JSON.stringify(me));

	const pens = await call(port, '/api/pens');
	check('listing pens requires login', pens.status === 401, await text(pens));

	const put = await call(port, '/api/pens/abc123', { method: 'PUT', body: penDoc() });
	check('saving requires login', put.status === 401, await text(put));

	const del = await call(port, '/api/pens/abc123', { method: 'DELETE' });
	check('deleting requires login', del.status === 401);

	const login = await call(port, '/login');
	const location = login.headers.get('location') ?? '';
	const jar = new Jar();
	jar.absorb(login);

	check('/login redirects to github', login.status === 302 && location.includes(`${stub.base}/login/oauth/authorize`), location);
	check('the authorize url carries the client id', location.includes('client_id=test-client'), location);
	check('the authorize url carries a state', /[?&]state=/.test(location), location);
	check('login sets the csrf state cookie', jar.names().includes('ucodepen_oauth'), JSON.stringify(jar.names()));
}

// -- 3. the full oauth flow --------------------------------------------------

console.log('github mode, the full login flow');
{
	const { port } = await boot('flow', {
		GITHUB_CLIENT_ID: 'test-client',
		GITHUB_CLIENT_SECRET: 'test-secret',
		SECRET_KEY: 'test-secret-key',
		GITHUB_WEB_BASE: stub.base,
		GITHUB_API_BASE: stub.base,
	});

	stub.state.codes.set('code-ok', { id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: 'http://a/1' });

	const jar = new Jar();
	const login = await call(port, '/login?next=/pen/', { jar });
	const state = new URL(login.headers.get('location')).searchParams.get('state');

	const cb = await call(port, `/api/auth/callback?code=code-ok&state=${encodeURIComponent(state)}`, { jar });
	check('the callback redirects into the app', cb.status === 302 && (cb.headers.get('location') ?? '').startsWith('/pen/'), `${cb.status} ${cb.headers.get('location')}`);
	check('the callback sets the session cookie', jar.names().includes('ucodepen_session'), JSON.stringify(jar.names()));

	const me = await json(await call(port, '/api/me', { jar }));
	check('the session identifies the user', me.authenticated === true && me.user?.login === 'octocat' && me.user?.name === 'The Octocat', JSON.stringify(me));

	const put = await call(port, '/api/pens/flowpen1', { method: 'PUT', body: penDoc('my pen'), jar });
	check('a signed-in user can save', put.ok, await text(put));

	const list = await json(await call(port, '/api/pens', { jar }));
	check('the pen shows up in the user list', list.pens.length === 1 && list.pens[0].name === 'my pen', JSON.stringify(list));

	const single = await json(await call(port, '/api/pens/flowpen1'));
	check('a single pen is readable without a session (share links)', single.name === 'my pen', JSON.stringify(single));

	const del = await call(port, '/api/pens/flowpen1', { method: 'DELETE', jar });
	check('the owner can delete', del.ok);

	const gone = await call(port, '/api/pens/flowpen1');
	check('it is really gone', gone.status === 404);

	// tampered state must fail
	const bad = await call(port, '/api/auth/callback?code=code-ok&state=forged');
	check('a forged state is rejected', bad.status === 400, await text(bad));

	// a code github does not know must fail cleanly
	const jar2 = new Jar();
	const login2 = await call(port, '/login', { jar: jar2 });
	const state2 = new URL(login2.headers.get('location')).searchParams.get('state');
	const badCode = await call(port, `/api/auth/callback?code=code-unknown&state=${encodeURIComponent(state2)}`, { jar: jar2 });
	check('an unknown code fails cleanly', badCode.status === 502, await text(badCode));
}

// -- 4. organisation restriction --------------------------------------------

console.log('github mode, organisation restriction');
{
	const { port } = await boot('org', {
		GITHUB_CLIENT_ID: 'test-client',
		GITHUB_CLIENT_SECRET: 'test-secret',
		GITHUB_ORG: 'ucode-lang',
		SECRET_KEY: 'test-secret-key',
		GITHUB_WEB_BASE: stub.base,
		GITHUB_API_BASE: stub.base,
	});

	stub.state.codes.set('code-member', { id: 12345, login: 'octocat', name: 'The Octocat', avatar_url: 'http://a/1' });

	const jar = new Jar();
	const login = await call(port, '/login', { jar });
	const location = login.headers.get('location') ?? '';

	check('the authorize url asks for read:org', location.includes('scope=read%3Aorg') || location.includes('scope=read:org'), location);

	const state = new URL(location).searchParams.get('state');
	const cb = await call(port, `/api/auth/callback?code=code-member&state=${encodeURIComponent(state)}`, { jar });
	check('a member gets in', cb.status === 302, `${cb.status}`);

	const me = await json(await call(port, '/api/me', { jar }));
	check('the member is signed in', me.authenticated === true, JSON.stringify(me));

	// now the same flow with a non-member
	stub.state.rejectOrg = true;
	stub.state.codes.set('code-outsider', { id: 999, login: 'outsider', name: null, avatar_url: null });

	const jar2 = new Jar();
	const login2 = await call(port, '/login', { jar: jar2 });
	const state2 = new URL(login2.headers.get('location')).searchParams.get('state');
	const cb2 = await call(port, `/api/auth/callback?code=code-outsider&state=${encodeURIComponent(state2)}`, { jar: jar2 });
	const page = await text(cb2);

	check('a non-member is rejected', cb2.status === 403, `${cb2.status}`);
	check('the rejection names the organisation', page.includes('ucode-lang'), page.slice(0, 200));

	stub.state.rejectOrg = false;
}

// -- 5. postgres -------------------------------------------------------------

if (process.env.TEST_PG_URL) {
	console.log('postgres store through the server');
	{
		const { port } = await boot('pg', {
			GITHUB_CLIENT_ID: 'test-client',
			GITHUB_CLIENT_SECRET: 'test-secret',
			SECRET_KEY: 'test-secret-key',
			GITHUB_WEB_BASE: stub.base,
			GITHUB_API_BASE: stub.base,
			DATABASE_URL: process.env.TEST_PG_URL,
		});

		stub.state.codes.set('code-a', { id: 111, login: 'user-a', name: 'User A', avatar_url: null });
		stub.state.codes.set('code-b', { id: 222, login: 'user-b', name: 'User B', avatar_url: null });

		const loginA = await call(port, '/login', { jar: new Jar() });
		const jarA = new Jar();
		jarA.absorb(loginA);
		await call(port, `/api/auth/callback?code=code-a&state=${encodeURIComponent(new URL(loginA.headers.get('location')).searchParams.get('state'))}`, { jar: jarA });

		const loginB = await call(port, '/login', { jar: new Jar() });
		const jarB = new Jar();
		jarB.absorb(loginB);
		await call(port, `/api/auth/callback?code=code-b&state=${encodeURIComponent(new URL(loginB.headers.get('location')).searchParams.get('state'))}`, { jar: jarB });

		const save = await call(port, '/api/pens/pgpen12', { method: 'PUT', body: penDoc('a keeps this'), jar: jarA });
		check('user a saves a pen', save.ok, await text(save));

		const clash = await call(port, '/api/pens/pgpen12', { method: 'PUT', body: penDoc('b tries to overwrite'), jar: jarB });
		check('user b cannot overwrite it', clash.status === 403, await text(clash));

		const read = await json(await call(port, '/api/pens/pgpen12', { jar: jarB }));
		check('user b can still read it (share link)', read.name === 'a keeps this');

		const delB = await call(port, '/api/pens/pgpen12', { method: 'DELETE', jar: jarB });
		check('user b cannot delete it', delB.status === 404, await text(delB));

		const listA = await json(await call(port, '/api/pens', { jar: jarA }));
		check("user a's list shows the pen", listA.pens.length === 1 && listA.pens[0].name === 'a keeps this', JSON.stringify(listA));

		const listB = await json(await call(port, '/api/pens', { jar: jarB }));
		check("user b's list is empty", listB.pens.length === 0, JSON.stringify(listB));

		const delA = await call(port, '/api/pens/pgpen12', { method: 'DELETE', jar: jarA });
		check('user a can delete it', delA.ok);

		const bad = await call(port, '/api/pens/pgpen13', { method: 'PUT', body: { files: 'nope' }, jar: jarA });
		check('a broken pen is rejected with 422', bad.status === 422, await text(bad));
	}
}
else {
	console.log('postgres: skipped (set TEST_PG_URL to run)');
}

// -- teardown ----------------------------------------------------------------

for (const s of servers)
	s.child.kill();

await sleep(300);
stub.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);