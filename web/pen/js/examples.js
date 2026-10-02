// Built-in pens. Each one exercises a different part of the model: template
// only, script + JSON + HTML, CSV data, non-HTML output, ucode modules, and a
// computation heavy page. test/pen.mjs runs every example and fails if one of
// them stops rendering.

export const EXAMPLES = [
	{
		name: 'hello template',
		description: 'One .ut file. Text in, expressions and loops inside tags.',
		files: [
			['hello.ut', `Hello {{ name ?? "world" }}!

{# a template comment: this line is not part of the output #}
{% let langs = ["ucode", "wasm", "the browser"] %}
counted:
{% for (let i = 0; i < length(langs); i = i + 1): %}
  {{ i + 1 }}. {{ langs[i] }}
{% endfor %}
upper: {{ lc("UCODE") }} | joined: {{ join(", ", langs) }}
math: {{ 2 ** 10 }} | sprintf: {{ sprintf("%.2f", 22 / 7.0) }}
`],
		],
	},

	{
		name: 'people page',
		description: 'The CodePen shape: .json data, .uc logic, .ut markup -> a real HTML page.',
		files: [
			['people.json', `[
  { "name": "Ada Lovelace",  "role": "engineer",  "age": 36, "tags": ["notes", "algorithms"] },
  { "name": "Grace Hopper",  "role": "admiral",   "age": 85, "tags": ["compilers", "cobol"] },
  { "name": "Linus Torvalds","role": "maintainer","age": 63, "tags": ["kernel", "git"] },
  { "name": "Phil Wich",     "role": "author",    "age": 44, "tags": ["ucode", "openwrt"] }
]
`],
			['main.uc', `// This file runs before the template. Everything declared here at top
// level -- let, const, function -- is visible in index.ut below.

let people = DATA.people;

function total(list, fn) {
    let sum = 0;

    for (let i = 0; i < length(list); i = i + 1)
        sum = sum + fn(list[i]);

    return sum;
}

let oldest = people[0];
let count = length(people);
let average = count > 0 ? total(people, (p) => p.age) / count : 0;
let tags = [];

for (let p in people)
    for (let t in p.tags)
        tags[length(tags)] = t;

tags = sort(uniq(tags));
`],
			['index.ut', `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { background:#0d1117; color:#c9d1d9; font:15px/1.6 ui-sans-serif, system-ui, sans-serif;
         margin:0; padding:32px; }
  h1 { font-size:22px; margin:0 0 4px; color:#58a6ff; }
  .sub { color:#8b949e; margin:0 0 24px; font-size:13px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:14px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:14px 16px; }
  .card h2 { margin:0 0 2px; font-size:16px; }
  .role { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .age { font-size:28px; font-weight:600; color:#3fb950; margin:8px 0 0; }
  .age span { font-size:12px; color:#8b949e; font-weight:400; }
  .tag { display:inline-block; background:#1f6feb22; color:#79c0ff; border-radius:999px;
         padding:1px 8px; font-size:11px; margin:6px 4px 0 0; }
  footer { margin-top:26px; color:#8b949e; font-size:12px; border-top:1px solid #30363d; padding-top:12px; }
</style>
</head>
<body>
<h1>{{ count }} people</h1>
<p class="sub">average age {{ sprintf("%.1f", average) }} &middot; {{ length(tags) }} distinct tags
&middot; rendered by ucode in your browser</p>

<div class="cards">
{% for (let p in people): %}
  <div class="card">
    <h2>{{ pen.esc(p.name) }}</h2>
    <div class="role">{{ pen.esc(p.role) }}</div>
    <div class="age">{{ p.age }} <span>years</span></div>
    {% for (let t in p.tags): %}<span class="tag">{{ pen.esc(t) }}</span>{% endfor %}
  </div>
{% endfor %}
</div>

<footer>oldest: {{ pen.esc(oldest.name) }} &middot; tags: {{ join(", ", tags) }}
&middot; DATA came from people.json, the numbers from main.uc</footer>
</body>
</html>
`],
		],
	},

	{
		name: 'csv to table',
		description: 'A .csv file becomes an array of row objects; the script aggregates it.',
		files: [
			['sales.csv', `region,quarter,units,price
north,Q1,120,9.5
north,Q2,140,9.5
south,Q1,90,12.0
south,Q2,210,11.5
east,Q1,60,14.0
east,Q2,75,14.0
west,Q1,300,7.25
`],
			['main.uc', `// DATA.sales is an array of objects, keyed by the csv header row.
let rows = DATA.sales;

function by(key) {
    let out = {};

    for (let r in rows) {
        let k = r[key];

        if (out[k] == null)
            out[k] = { key: k, units: 0, revenue: 0.0 };

        // csv values arrive as strings; arithmetic coerces them, and * 1.0
        // keeps the result a float instead of an int
        out[k].units = out[k].units + int(r.units);
        out[k].revenue = out[k].revenue + r.units * r.price * 1.0;
    }

    return values(out);
}

let regions = sort(by("region"), (a, b) => b.revenue - a.revenue);
let grand = 0.0;
let total_units = 0;

for (let r in regions) {
    grand = grand + r.revenue;
    total_units = total_units + r.units;
}

let top = regions[0];
`],
			['table.ut', `<!doctype html>
<html><head><meta charset="utf-8"><style>
 body { background:#0d1117; color:#c9d1d9; font:15px/1.5 ui-sans-serif, system-ui, sans-serif; padding:28px; margin:0; }
 h1 { font-size:20px; color:#58a6ff; margin:0 0 18px; }
 table { border-collapse:collapse; width:100%; max-width:640px; }
 th, td { padding:8px 12px; border-bottom:1px solid #30363d; text-align:right; }
 th:first-child, td:first-child { text-align:left; }
 th { color:#8b949e; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
 .bar { height:8px; background:#1f6feb; border-radius:4px; }
 tr.total td { font-weight:600; color:#3fb950; border-top:2px solid #30363d; }
</style></head><body>
<h1>Revenue by region</h1>
<table>
  <tr><th>region</th><th>units</th><th>revenue</th><th>share</th></tr>
{% for (let r in regions): %}
  <tr>
    <td>{{ pen.esc(r.key) }}</td>
    <td>{{ r.units }}</td>
    <td>{{ sprintf("$%.2f", r.revenue) }}</td>
    <td><div class="bar" style="width:{{ sprintf("%.0f", r.revenue / grand * 100) }}px"></div></td>
  </tr>
{% endfor %}
  <tr class="total"><td>total</td><td>{{ total_units }}</td>
      <td>{{ sprintf("$%.2f", grand) }}</td><td></td></tr>
</table>
<p style="color:#8b949e;font-size:13px">top region: {{ top.key }} &middot; {{ length(rows) }} csv rows read</p>
</body></html>
`],
			['notes.txt', `sales.csv is parsed by the runner: the first line becomes the object keys,
so the script can say r.units and r.price instead of indexing columns.
PEN.lines.sales holds the raw lines if you would rather parse it yourself.
`],
		],
	},

	{
		name: 'config generator',
		description: 'Templates do not have to produce HTML -- here one emits a config file.',
		files: [
			['network.json', `{
  "domain": "lab.example",
  "gateway": "10.1.0.1",
  "lease_time": 3600,
  "hosts": [
    { "mac": "a0:36:9f:11:22:33", "name": "printer",  "ip": "10.1.0.20" },
    { "mac": "44:d1:fa:9e:88:77", "name": "nas",      "ip": "10.1.0.30" },
    { "mac": "b8:27:eb:1c:2d:3e", "name": "rpi-edge", "ip": "10.1.0.40" }
  ]
}
`],
			['main.uc', `let cfg = DATA.network;
let pool_start = 100;
let generated = pen.out("hosts.json", sprintf("%.J", cfg.hosts));
`],
			['dhcp.conf', `# generated from network.json by ucodepen -- do not edit by hand
# {{ length(cfg.hosts) }} static leases, pool starts at {{ pool_start }}

option domain-name "{{ cfg.domain }}";
option routers {{ cfg.gateway }};
default-lease-time {{ cfg.lease_time }};

{% for (let h in cfg.hosts): %}
host {{ h.name }} {
    hardware ethernet {{ h.mac }};
    fixed-address {{ h.ip }};
}
{% endfor %}
pool {
    range {{ cfg.gateway }}{{ pool_start }};
}
`],
		],
	},

	{
		name: 'ucode modules',
		description: 'A .uc file with export becomes a module: import it from a script.',
		files: [
			['money.uc', `// A .uc file that exports something is treated as a module: it is not
// executed as a script, it is imported by name.

export function cents(amount) {
    return int(amount * 100);
}

export function fmt(c, currency) {
    return sprintf("%s%d.%02d", currency ?? "$", c / 100, c % 100);
}

export const SYMBOLS = { eur: "\\u20ac", usd: "$", jpy: "\\u00a5" };
`],
			['main.uc', `import { cents, fmt, SYMBOLS } from "money";

let prices = [1.5, 12, 0.99, 7.25];
let lines = map(prices, (p) => ({ raw: p, usd: fmt(cents(p), SYMBOLS.usd), eur: fmt(cents(p), SYMBOLS.eur) }));
let sum = 0;

for (let l in lines)
    sum = sum + l.raw;

let total_usd = fmt(cents(sum), SYMBOLS.usd);
`],
			['index.ut', `<!doctype html><html><head><meta charset="utf-8"><style>
 body{background:#0d1117;color:#c9d1d9;font:15px ui-monospace, monospace;padding:28px;margin:0}
 h1{color:#58a6ff;font-size:18px} table{border-collapse:collapse} td{padding:4px 16px;border-bottom:1px solid #30363d}
 tfoot td{color:#3fb950;font-weight:600;border-top:2px solid #30363d}
 .src{color:#8b949e;font-size:12px;margin-top:18px}
</style></head><body>
<h1>money.uc imported into main.uc</h1>
<table>
{% for (let l in lines): %}
  <tr><td>{{ l.raw }}</td><td>{{ l.usd }}</td><td>{{ l.eur }}</td></tr>
{% endfor %}
  <tfoot><tr><td>sum</td><td>{{ total_usd }}</td><td>{{ fmt(cents(sum), SYMBOLS.eur) }}</td></tr></tfoot>
</table>
<div class="src">require("money") works too; import gives you the exported names directly.</div>
</body></html>
`],
		],
	},

	{
		name: "Conway's life",
		description: 'Compute in the script, render a grid from the template.',
		files: [
			['main.uc', `let w = 48, h = 22, gens = 12;

function blank() {
    let grid = [];

    for (let y = 0; y < h; y = y + 1) {
        grid[y] = [];

        for (let x = 0; x < w; x = x + 1)
            grid[y][x] = 0;
    }

    return grid;
}

// deterministic "random" seed, so the pen always renders the same way
function seed() {
    let g = blank(), s = 12345;

    for (let y = 0; y < h; y = y + 1)
        for (let x = 0; x < w; x = x + 1) {
            s = (s * 1103515245 + 12345) % 2147483648;
            g[y][x] = s % 100 < 30 ? 1 : 0;
        }

    return g;
}

function step(g) {
    let n = blank();

    for (let y = 0; y < h; y = y + 1)
        for (let x = 0; x < w; x = x + 1) {
            let alive = 0;

            for (let dy = -1; dy <= 1; dy = dy + 1)
                for (let dx = -1; dx <= 1; dx = dx + 1) {
                    if (dx == 0 && dy == 0)
                        continue;

                    let yy = y + dy, xx = x + dx;

                    if (yy >= 0 && yy < h && xx >= 0 && xx < w)
                        alive = alive + g[yy][xx];
                }

            n[y][x] = (g[y][x] == 1 && (alive == 2 || alive == 3)) || (g[y][x] == 0 && alive == 3) ? 1 : 0;
        }

    return n;
}

let grid = seed();
let history = [];

for (let i = 0; i < gens; i = i + 1) {
    let rows = [];

    for (let y = 0; y < h; y = y + 1)
        rows[y] = join("", map(grid[y], (c) => c ? "#" : "."));

    history[length(history)] = { n: i, rows: rows };
    grid = step(grid);
}
`],
			['life.ut', `<!doctype html><html><head><meta charset="utf-8"><style>
 body{background:#0d1117;color:#c9d1d9;font:12px/1.15 ui-monospace,monospace;padding:24px;margin:0}
 h1{color:#58a6ff;font-size:16px;font-family:ui-sans-serif,system-ui}
 .gen{margin-bottom:10px}
 .gen b{color:#8b949e;font-weight:400;font-size:11px}
 pre{margin:2px 0 0;white-space:pre;color:#1f6feb;text-shadow:0 0 6px #1f6feb55}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
</style></head><body>
<h1>Conway's game of life &mdash; {{ length(history) }} generations of {{ length(history[0].rows) }}x{{ length(history[0].rows[0]) }}</h1>
<div class="grid">
{% for (let g in history): %}
  <div class="gen"><b>gen {{ g.n }}</b><pre>{% for (let r in g.rows): %}{{ r }}
{% endfor %}</pre></div>
{% endfor %}
</div>
</body></html>
`],
		],
	},
];

export function exampleAt(i) {
	const ex = EXAMPLES[Math.max(0, Math.min(i, EXAMPLES.length - 1))];

	return {
		name: ex.name,
		description: ex.description,
		files: ex.files.map(([name, content]) => ({ name, content })),
	};
}