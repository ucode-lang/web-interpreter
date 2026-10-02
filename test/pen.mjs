// Node test harness for the ucodepen run pipeline.
//
//   node test/pen.mjs
//
// Drives web/pen/js/pipeline.js against dist/ucode.js -- the same code path the
// browser's Web Worker takes, minus the worker.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

const { makeBridge } = await import(pathToFileURL(join(root, 'web/pen/js/bridge.js')).href);
const { runProject, preparedFiles, looksLikeHtml } = await import(
	pathToFileURL(join(root, 'web/pen/js/pipeline.js')).href
);
const { topLevelDecls } = await import(pathToFileURL(join(root, 'web/pen/js/scan.js')).href);

// dist/ucode.js is a UMD glue script; load it through node's CJS loader.
const ucodeWasm = require(join(root, 'dist/ucode.js'));

const runnerSource = readFileSync(join(root, 'web/pen/runner.uc'), 'utf8');

const bridge = makeBridge(await ucodeWasm());

// ---------------------------------------------------------------------------

let passed = 0, failed = 0;

function check(name, cond, detail = '') {
	if (cond) {
		passed++;
		console.log(`  ok   ${name}`);
	}
	else {
		failed++;
		console.log(`  FAIL ${name}${detail ? `\n         ${String(detail).replace(/\n/g, '\n         ')}` : ''}`);
	}
}

function pen(name, files) {
	return { name, files: files.map(([n, c]) => ({ name: n, content: c })) };
}

function run(files, name = 'test') {
	return runProject(bridge, pen(name, files), { runnerSource });
}

// ---------------------------------------------------------------------------
console.log('runner: shared scope');
{
	const r = run([
		['main.uc', 'let greeting = "hello"; let n = 3;\nfunction shout(s) { return s + "!" }\n'],
		['index.ut', 'A={{ greeting }} B={{ n }} C={{ shout("x") }}\n'],
	]);

	check('scripts and templates share one scope', r.ok, r.error);
	check('template output', r.outputs[0]?.text === 'A=hello B=3 C=x!\n', JSON.stringify(r.outputs[0]?.text));
	check('no console noise', r.console === '', JSON.stringify(r.console));
	check('two steps recorded', r.steps.length === 2, JSON.stringify(r.steps.map((s) => s.kind)));
}

console.log('runner: file order and cross-file use');
{
	const r = run([
		['lib.uc', 'function twice(x) { return x * 2 }\n'],
		['main.uc', 'let v = twice(21);\n'],
		['index.ut', '{{ v }}\n'],
	]);

	check('earlier script visible to later one', r.ok && r.outputs[0]?.text.trim() === '42', r.error ?? r.outputs[0]?.text);
}

console.log('runner: data files');
{
	const r = run([
		['main.uc', 'let first = DATA.people[0].name; let sum = 0;\nfor (let p in DATA.people) sum = sum + p.age;\nlet lines = DATA.numbers;\nlet csv0 = DATA.rows[0];\n'],
		['people.json', '[{"name":"Ada","age":36},{"name":"Grace","age":85}]'],
		['numbers.txt', '3\n14\n15\n'],
		['rows.csv', 'a,b\n1,2\n3,4\n'],
		['index.ut', 'first={{ first }} sum={{ sum }} txt=[{{ DATA.numbers }}] rows={{ length(PEN.lines.numbers) }} csv={{ csv0.a }}/{{ csv0.b }} raw={{ length(PEN.raw.numbers) }}\n'],
	]);

	check('json/csv/text all parse', r.ok, r.error);
	check('values reach the template',
		(r.outputs.find((o) => o.name === 'index.ut')?.text ?? '').trim() === 'first=Ada sum=121 txt=[3\n14\n15\n] rows=3 csv=1/2 raw=8',
		JSON.stringify(r.outputs.map((o) => o.text)));
	check('json is structured, text is not',
		r.inspect?.data?.find((d) => d.name === 'people')?.type === 'array' &&
		r.inspect?.data?.find((d) => d.name === 'numbers')?.type === 'string',
		JSON.stringify(r.inspect?.data));
}

console.log('runner: quoted csv and crlf');
{
	const r = run([
		['main.uc', 'let a = DATA.t[0]; let b = DATA.t[1];\n'],
		['t.csv', 'name,note\r\n"Doe, John","said ""hi"""\r\nx,y\r\n'],
		['index.ut', '{{ a.name }}|{{ a.note }}|{{ b.name }}|{{ length(DATA.t) }}\n'],
	]);

	check('csv quoting and \\r\\n', r.ok && r.outputs[0]?.text.trim() === 'Doe, John|said "hi"|x|2', r.error ?? r.outputs[0]?.text);
}

console.log('runner: html output detection');
{
	const r = run([
		['index.ut', '<!doctype html>\n<html><body><p>{{ 1 + 1 }}</p></body></html>\n'],
		['conf.ut', 'listen = {{ 80 }};\n'],
	]);

	check('html template detected', r.outputs[0]?.html === true, JSON.stringify(r.outputs[0]));
	check('text template not html', r.outputs[1]?.html === false, JSON.stringify(r.outputs[1]));
	check('both rendered', r.outputs.length === 2 && r.outputs[1].text === 'listen = 80;\n', JSON.stringify(r.outputs.map((o) => o.text)));
}

console.log('runner: script error reporting');
{
	const r = run([
		['main.uc', 'let a = 1;\nlet b = nosuchfunction(a);\n'],
		['index.ut', 'never\n'],
	]);

	check('run reports failure', r.ok === false);
	check('error names the file', r.firstError?.name === 'main.uc', JSON.stringify(r.firstError));
	check('error points at line 2', r.firstError?.error?.line === 2, JSON.stringify(r.firstError?.error));
	check('templates skipped', r.outputs.length === 0 && r.skipped === 1, JSON.stringify({ o: r.outputs.length, s: r.skipped }));
	check('console untouched', typeof r.console === 'string');
}

console.log('runner: compile error reporting');
{
	const r = run([['main.uc', 'let a = ;\n']]);

	check('syntax error surfaces', r.ok === false, JSON.stringify(r.error));
	check('syntax error message kept', /Syntax error/.test(r.error ?? ''), r.error);
}

console.log('runner: template error reporting');
{
	const r = run([
		['main.uc', 'let ok = 1;\n'],
		['bad.ut', 'line one\n{{ boom(1) }}\n'],
	]);

	check('template failure reported', r.ok === false);
	check('template error names file', r.firstError?.name === 'bad.ut', JSON.stringify(r.firstError));
	check('template error line', r.firstError?.error?.line === 2, JSON.stringify(r.firstError?.error));
}

console.log('runner: console output, pen helpers');
{
	const r = run([
		['main.uc', 'print("from script\\n"); let extra = pen.out("report.txt", "value=" + 42); let h = pen.use("fmt"); let made = h.money(3);\n'],
		['fmt.uc', 'function money (cents) { return "$" + sprintf("%.2f", cents / 100.0) }\n'],
		['index.ut', 'made={{ made }} files={{ length(PEN.files) }} scripts={{ length(PEN.scripts) }}\n'],
	]);

	const page = r.outputs.find((o) => o.name === 'index.ut');

	check('pen.out() emits an extra document', r.outputs.some((o) => o.name === 'report.txt' && o.text === 'value=42'),
		JSON.stringify(r.outputs.map((o) => [o.name, o.text])));
	check('script stdout captured', r.console.includes('from script'), JSON.stringify(r.console));
	check('pen.use() child scope works', r.ok && page?.text.includes('made=$0.03'), r.error ?? JSON.stringify(page?.text));
	check('pen.files / pen.scripts are accurate', page?.text.includes('files=3') && page?.text.includes('scripts=2'),
		JSON.stringify(page?.text));
}

console.log('runner: stderr capture');
{
	const r = run([
		['main.uc', 'print("out\\n"); warn("err line\\n");\n'],
	]);

	check('stdout and stderr stay separate', r.console.includes('out') && !r.console.includes('err line'),
		JSON.stringify({ console: r.console, stderr: r.stderr }));
	check('warn() lands in stderr', r.stderr.includes('err line'), JSON.stringify(r.stderr));
}

console.log('runner: stdio flush and re-run isolation');
{
	const r1 = run([
		['main.uc', 'warn("partial");\n'],
	]);

	check('partial stderr line is flushed at end of run', r1.stderr.includes('partial'),
		JSON.stringify(r1.stderr));

	const r2 = run([
		['main.uc', 'warn("fresh\\n");\n'],
	]);

	check('re-run does not inherit the previous partial line',
		!r2.stderr.includes('partial') && r2.stderr.includes('fresh'), JSON.stringify(r2.stderr));
}

console.log('runner: pen files as modules');
{
	const r = run([
		['mathy.uc', 'export function cube(x) { return x * x * x }\n'],
		['main.uc', 'import { cube } from "mathy"; let v = cube(3);\nimport * as m from "mathy"; let w = m.cube(2);\n'],
		['index.ut', '{{ v }} {{ w }}\n'],
	]);

	check('import from a pen file', r.ok && r.outputs[0]?.text.trim() === '27 8', r.error ?? r.outputs[0]?.text);
	check('a module is not executed as a script',
		r.steps.filter((s) => s.kind === 'script').map((s) => s.name).join(',') === 'main.uc',
		JSON.stringify(r.steps.map((s) => [s.kind, s.name])));

	const returned = run([
		['helpers.uc', 'function triple(x) { return x * 3 }\n'],
		['main.uc', 'let h = require("helpers"); let v = h.triple(4);\n'],
		['index.ut', '{{ v }}\n'],
	]);

	check('require() of a script file yields the shared pen scope',
		returned.ok && returned.outputs[0]?.text.trim() === '12', returned.error ?? returned.outputs[0]?.text);
}

console.log('runner: builtin modules still resolve');
{
	const r = run([
		['main.uc', 'let fs = require("fs"); let m = require("math"); let v = m.floor(m.sqrt(17)); let names = fs.lsdir("/pen");\n'],
		['index.ut', 'v={{ v }} files={{ length(names) }}\n'],
	]);

	check('require("fs")/require("math") work', r.ok, r.error);
	check('values computed', /v=4 files=[1-9]/.test(r.outputs[0]?.text ?? ''), r.outputs[0]?.text);
}

console.log('runner: inspector');
{
	const r = run([
		['main.uc', 'let visible = "yes"; let list = [1,2,3];\nhidden = "also";\n'],
		['data.json', '{"k":1}'],
		['index.ut', 'x\n'],
	]);

	const names = r.inspect?.names ?? [];
	const named = names.map((n) => n.name);

	check('inspector lists published lets', named.includes('visible') && named.includes('list'), JSON.stringify(named));
	check('inspector lists bare assignments', names.some((n) => n.name === 'hidden' && n.where === 'global'), JSON.stringify(names));
	check('inspector lists data', (r.inspect?.data ?? []).some((d) => d.name === 'data'), JSON.stringify(r.inspect?.data));
	check('inspector previews', names.find((n) => n.name === 'list')?.preview === '[3 items]', JSON.stringify(names.find((n) => n.name === 'list')));
}

console.log('runner: unicode and long output');
{
	const big = 'x'.repeat(200000);
	const r = run([
		['main.uc', `let u = "héllo ✓"; let big = "";\nfor (let i = 0; i < 2000; i = i + 1) big = big + "0123456789";\n`],
		['index.ut', '{{ u }} {{ length(big) }}\n'],
	]);

	check('unicode survives', r.ok && r.outputs[0]?.text.startsWith('héllo ✓'), r.error ?? r.outputs[0]?.text);
	check('output beyond the old 8 KiB cap', /20000/.test(r.outputs[0]?.text ?? ''), r.outputs[0]?.text.slice(0, 40));
}

console.log('scan: top level declarations');
{
	const cases = [
		['let a = 1; let b = 2;', ['a', 'b']],
		['let a = 1, b = 2;\nfunction f(x) { let inner = 1; return inner }\nconst K = 3;', ['a', 'b', 'f', 'K']],
		['let s = "let fake = 1"; let real = 2;', ['s', 'real']],
		["let t = `a ${ 'x' } b`; // let nope = 3\nlet u = 1;", ['t', 'u']],
		['/* let block = 1 */ let v = /a{2}/; let w = 1;', ['v', 'w']],
		['for (let i = 0; i < 2; i = i + 1) { let j = i; }\nlet after = 1;', ['after']],
		['if (1) { let inside = 1; }\nlet outside = 1;', ['outside']],
		['let obj = { a: 1, b: function () { return 2 } };\nlet arr = [1, 2, 3];', ['obj', 'arr']],
		['let re = "x" ; let div = 4 / 2; let z = 1;', ['re', 'div', 'z']],
		['let __internal = 1; let shown = 2;', ['shown']],
	];

	for (const [src, want] of cases) {
		const got = topLevelDecls(src);

		check(`decls ${JSON.stringify(src.slice(0, 34))}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
	}

	const withFooter = preparedFiles(pen('f', [['a.uc', 'let x = 1']]));

	check('footer appended to scripts', /__pen_scope\.x = x/.test(withFooter[0].content), withFooter[0].content);
}

console.log('pipeline: html sniffing');
{
	check('html', looksLikeHtml('<div>x</div>'));
	check('not html', !looksLikeHtml('listen = 80;'));
	check('not html (empty)', !looksLikeHtml(''));
}

console.log('modules: pen files act as ucode modules');
{
	const r = run([
		['lib.uc', 'export function twice(n) {\n\treturn n * 2;\n}\n\nexport const tag = "lib";\n'],
		['main.uc', 'import { twice, tag } from "lib";\nlet v = twice(21);\nprint("printed: ", v, " ", tag, "\\n");\n'],
		['index.ut', '{{ tag }}={{ v }}\n'],
	]);
	const bad = r.steps.find((s) => !s.ok);

	check('named import from a pen file', r.ok, bad ? bad.error.text : '');
	check('imported value reaches the template', (r.outputs[0]?.text ?? '').trim() === 'lib=42', JSON.stringify(r.outputs[0]?.text));
	check('print() lands in the console', /printed: 42 lib/.test(r.console), JSON.stringify(r.console));
	check('a file with exports is not auto-run as a script', !r.steps.some((s) => s.name === 'lib.uc'),
		JSON.stringify(r.steps.map((s) => s.name)));
}
{
	const r = run([
		['lib.uc', 'export function twice(n) { return n * 2; }\n'],
		['main.uc', 'import * as lib from "lib";\nlet v = lib.twice(4);\n'],
		['index.ut', '{{ v }}\n'],
	]);

	check('namespace import', r.ok && (r.outputs[0]?.text ?? '').trim() === '8',
		JSON.stringify({ ok: r.ok, out: r.outputs[0]?.text, err: r.steps.find((s) => !s.ok)?.error?.text }));
}
{
	const r = run([
		['alpha.uc', 'export const label = "alpha";\n'],
		['beta.uc', 'import { label } from "alpha";\nexport const chain = label + "->beta";\n'],
		['main.uc', 'import { chain } from "beta";\nlet v = chain;\n'],
		['index.ut', '{{ v }}\n'],
	]);

	check('a module may import another module', r.ok && (r.outputs[0]?.text ?? '').trim() === 'alpha->beta',
		JSON.stringify({ ok: r.ok, out: r.outputs[0]?.text, err: r.steps.find((s) => !s.ok)?.error?.text }));
}
{
	// `export default function f()` is rejected by ucode, `export default f` is not
	const r = run([
		['cube.uc', 'function cube(n) { return n * n * n; }\n\nexport default cube;\n'],
		['main.uc', 'import cube from "cube";\nlet v = cube(3);\n'],
		['index.ut', '{{ v }}\n'],
	]);

	check('default export/import', r.ok && (r.outputs[0]?.text ?? '').trim() === '27',
		JSON.stringify({ ok: r.ok, out: r.outputs[0]?.text, err: r.steps.find((s) => !s.ok)?.error?.text }));
}

console.log('examples: every built-in pen renders');
{
	const { EXAMPLES } = await import(pathToFileURL(join(root, 'web/pen/js/examples.js')).href);

	// ucode's join() takes the separator FIRST and silently returns null when
	// the arguments are swapped -- exactly the kind of bug that still "renders"
	// but with empty holes. Each example therefore asserts real content.
	const expect = {
		'hello template': [/joined: ucode, wasm, the browser/, /counted:/, /3\. the browser/],
		'people page': [/tags: algorithms, cobol/, /oldest: Ada Lovelace/, /average/],
		'csv to table': [/south/, /<table/, /top region/],
		'config generator': [/option domain-name "lab\.example"/, /host printer/, /pool starts at 100/],
		"Conway's life": [/gen 0/, /gen 11/, /#{10,}/],
	};

	check('examples defined', EXAMPLES.length >= 5, EXAMPLES.length);

	for (const ex of EXAMPLES) {
		const r = run(ex.files.map(([n, c]) => [n, c]), ex.name);
		const bad = r.steps.find((s) => !s.ok);

		check(`${ex.name} runs`, r.ok && r.outputs.length > 0, bad ? `${bad.kind} ${bad.name}: ${bad.error?.text}` : JSON.stringify({ ok: r.ok, outputs: r.outputs.length }));

		for (const o of r.outputs)
			check(`  ${ex.name} / ${o.name} has no unresolved tags`, !/\{\{|\{%|undefined|\(null\)/.test(o.text),
				JSON.stringify(o.text.slice(0, 200)));

		for (const re of expect[ex.name] ?? [])
			check(`  ${ex.name} renders ${re}`, re.test(r.outputs.map((o) => o.text).join('\n')),
				JSON.stringify(r.outputs.map((o) => o.text).join('\n').slice(0, 300)));
	}
}

console.log('builtins: argument orders the examples rely on');
{
	// join() is the outlier: separator first, array second, silent null when the
	// second argument is not an array. Pin it down so a future example cannot
	// silently regress the way the life grids did.
	const r = run([
		['main.uc', 'let dash = join("-", ["a", "b"]);\nlet glue = join("", ["x", "y", "z"]);\n'],
		['index.ut', '{{ dash }}|{{ glue }}|{{ "" + join(42, ["a"]) }}\n'],
	]);

	check('join(sep, arr) joins', r.ok && (r.outputs[0]?.text ?? '').trim() === 'a-b|xyz|a',
		JSON.stringify({ ok: r.ok, out: r.outputs[0]?.text, err: r.steps.find((s) => !s.ok)?.error?.text }));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);