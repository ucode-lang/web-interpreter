# ucode web

A web-based interpreter for [ucode](https://ucode-lang.org), compiled to
WebAssembly with Emscripten. Runs ucode in the browser (or Node) with a
JS-callable API, a built-in REPL, and statically-linked standard-library
modules.

## How it works

ucode natively loads standard-library modules (math, io, fs, struct, …) as
dynamic shared objects via `dlopen`/`dlsym`, which is not available in the
browser. This project builds ucode with its **emscripten/wasm32 CMake
support** and replaces the dlopen-based module resolution with **preloading**:

1. Every built-in module is compiled into the same WASM binary
   (`ucode-modules.a`), each with `uc_module_init()` renamed to
   `uc_module_init_<name>()` so the modules can coexist in one address
   space.
2. At VM init the bridge calls each renamed init and registers the module
   object in the global `modules` dictionary. `uc_require_path()` checks
   that dictionary before the search path, so `require()` of a built-in
   name resolves to the preloaded object.
3. The same names are listed in the parse config's `force_dynlink_list`, so
   the compiler treats them as dynamic-link modules: `import { x } from
   "math"` compiles to a runtime lookup of the preloaded object instead of
   a file search.

The result is a single self-contained `ucode.wasm` (+ `ucode.js` glue) with
no external dynamic loading and no OS dependencies.

## Layout

```
build.sh          build the WASM module (needs EMSDK + cmake on PATH)
CMakeLists.txt    the build: fetches ucode, builds the bridge
  UCODE_GIT_TAG   pinned ucode commit (emscripten-support branch)
cmake/
  emscripten.cmake       emscripten toolchain file
  gen-demo-inc.cmake     embeds demo/ as C string literals
src/
  web-bridge.c    JS-facing API + module preloading
  web-bridge.js   stderr capture + TTY flush (compiled in via --pre-js)
  web-bridge-modules.inc   generated per-build (module table)
  web-bridge-demo.inc      generated per-build (demo/ tree)
web/
  index.html      minimal REPL UI
  ucode.js        built glue (committed build artifact, see Building)
  ucode.wasm      built runtime (committed build artifact, see Building)
  pen/            ucodepen, the multi-file playground (see below)
dist/             raw build output (generated)
serve.py          static server + tiny pen storage API
notes/            design notes gathered while exploring the ucode internals
test/pen.mjs      node test suite for the pen pipeline
```

## Building

Requires [Emscripten](https://emscripten.org) (emsdk) and CMake on your
`PATH`, e.g.:

```
source /path/to/emsdk/emsdk_env.sh
./build.sh
```

This fetches the pinned ucode commit (and builds its json-c and libmd
dependencies -- network access needed), links the bridge into
dist/ucode.{js,wasm}, and copies the runtime into web/. The web/ artifacts
are committed, so a fresh clone deploys without a WASM toolchain; after
changing the C sources, re-run ./build.sh and commit the new artifacts.

Currently statically linked modules: `io`, `math`, `struct`, `fs`, `zlib`,
`resolv`, `socket`, `digest`. (Server-side socket APIs are compiled in but
not supported by emscripten; Linux-only networking modules `ubus`, `rtnl`,
`nl80211` are not compiled for the browser target.)

## Running the web REPL

Serve the `web/` directory and open `index.html`:

```
python3 -m http.server 8000 --directory web
# open http://localhost:8000/index.html
```

Type statements and press Enter. Single expressions (that don't start with a
statement keyword) are evaluated and their result echoed; everything else is
run as a script.

## JS API

The built module factory is exposed as the global `ucodeWasm`. Call it to get
a ready emscripten `Module` object:

```js
ucodeWasm().then((M) => {
  const len = M.lengthBytesUTF8(src);
  const ptr = M._malloc(len + 1);
  M.stringToUTF8(src, ptr, len + 1);

  M._ucode_run(ptr);          // run src as a script
  // M._ucode_eval(ptr);      // run src as an expression, print result

  const out = M.UTF8ToString(M._ucode_get_output());   // captured stdout
  const err = M.UTF8ToString(M._ucode_get_error());    // last error
  M._ucode_clear_output();

  M._free(ptr);
});
```

Note: ucode source is passed as a **pointer into wasm memory** (write it with
`stringToUTF8` first). This is used instead of emscripten's automatic
JS→C string conversion, which is unreliable when the function is called after
the module's initial run in MODULARIZE mode.

Captured output: ucode's `print()` normally writes to `stdout`, but in a
MODULARIZE build C-level stdout writes after init are dropped by emscripten.
The bridge therefore redirects ucode's output `FILE*` to an
`open_memstream()` buffer, which is exposed to JS via `ucode_get_output()`.

## Node smoke test

```
node -e '
require("./dist/ucode.js")().then(M => {
  const w = s => { const l = M.lengthBytesUTF8(s); const p = M._malloc(l+1); M.stringToUTF8(s,p,l+1); return p; };
  M._ucode_run(w("let m = require(\"math\"); print(m.sqrt(16))"));
  console.log(M.UTF8ToString(M._ucode_get_output()));
});'
```

# ucodepen

`web/pen/` is a CodePen-style playground built on the same WASM runtime. There
is no HTML or CSS pane on purpose: a **pen is a project of files**, and the
page you see is whatever your ucode programs produce.

| file | role | what the runner does with it |
|------|------|------------------------------|
| `*.uc` | logic | compiled and called with the shared scope, in list order |
| `*.uc` containing a top level `export` | module | never auto-run; reached with `import` / `require` |
| `*.ut` | output | compiled in ucode **template mode** and rendered against the scope |
| `*.json`, `*.csv`, `*.tsv`, `*.txt` | model | parsed (or kept raw) and published as `DATA.<name>` |

The first template in the file list becomes the preview pane; every other
template, and anything a script emits with `PEN.out()`, shows up in the output
selector next to it. `print()` and `warn()` in a script go to the stdio pane.

## Running it

```
./serve.py 8000
# open http://127.0.0.1:8000/pen/
```

`serve.py` is stdlib-only: it serves `web/` and adds a small storage API
(`GET/PUT/DELETE /api/pens[/<id>]`, `GET /p/<id>` -> redirect to the app,
`GET /run/<code>` -> redirect to the REPL with `#code=<code>`) that
saves pens as JSON under `pens/`. Without it the app still works -- plain
static hosting is fine, pens then live in `localStorage` and sharing happens
through the URL fragment.

The REPL at `/` runs code from a deep link: `/#code=<source>` executes
`<source>` on load (bare expressions print their result), and
`/run/<source>` is the shareable short form of the same thing.

## Deployment

The production shape is two containers: the app and a Postgres that stores
pens and users, with optional GitHub login.

```
cp .env.example .env      # fill in the values, see the comments in there
docker compose up -d --build
```

With nothing configured the server runs in local mode: no login, one shared
pen store (the same behaviour as `serve.py`). With GitHub credentials set,
pens belong to signed-in users; listing, saving and deleting need a session,
while single-pen links (`/p/<id>`) stay public.

### TLS front end

`deploy/haproxy/` -- haproxy as a host service + acme.sh for the Let's
Encrypt certs, with the app stack on loopback only.

### GitHub login

Register an OAuth App under your personal account at
<https://github.com/settings/applications/new> -- GitHub removed
organisation-owned OAuth apps, and the owner does not matter: any GitHub user
can authorise the app, the restriction to your organisation is enforced here.

- Homepage URL: `https://run.ucode-lang.org`
- Authorization callback URL: `https://run.ucode-lang.org/api/auth/callback`

Put the client id and secret into `.env` together with `GITHUB_ORG=ucode-lang`
to only accept members of that organisation (the app then asks for the
`read:org` scope and the login callback checks the membership). Leave
`GITHUB_ORG` empty to allow any GitHub account. `SECRET_KEY` signs the session
cookies -- set a long random value (`openssl rand -hex 32`), otherwise every
container restart logs everybody out.

### TLS

Behind a reverse proxy that sets `X-Forwarded-Proto`, point `BASE_URL` at the
public origin and publish the app port. For TLS, use the haproxy + acme.sh
front end (`deploy/haproxy/`).

Pens live in the `pgdata` docker volume; back that up (`docker run --rm -v
ucodepen_pgdata:/data -v $PWD:/backup alpine tar czf /backup/pens.tar.gz -C
/var/lib/postgresql data`).

## How a run works

1. `js/pipeline.js` mirrors the editor buffers into the interpreter's virtual
   filesystem (`ucode_vfs_write`) under `/pen/`, plus a generated manifest
   `/pen/.pen.json` and the execution kernel `runner.uc`.
2. `runner.uc` loads the data files, runs each script with
   `call(loadfile(path), null, scope)` against **one shared scope object**, then
   renders each template with `render(path, scope)` and writes the results to
   `/pen/.out/` along with `report.json` (per-step status, timings, errors).
3. Top level `let`/`const`/`function` are locals of a program's main function,
   so they are invisible from outside. `js/scan.js` therefore scans each script
   for top level declarations and appends a footer that republishes them into
   the shared scope. The footer starts with `;` because ucode has no automatic
   semicolon insertion.
4. The whole thing runs in a Web Worker. A runaway pen is stopped by
   `worker.terminate()` after the timeout (2/5/15/60 s, selectable) and a fresh
   worker is booted. This is the only reliable kill switch: ucode compiles tail
   calls into jumps, so `function f(n) { return f(n + 1) }` never overflows the
   stack, and a wasm loop cannot be interrupted from the main thread.

## Modules

`REQUIRE_SEARCH_PATH` starts with `/pen/*.uc`, so pen files are importable by
name:

```js
// lib.uc
export function twice(n) {
    return n * 2;
}

// main.uc
import { twice } from "lib";        // named export
import * as lib from "lib";         // namespace
import cube from "cube";            // default (write `export default cube;`)
```

Notes on ucode's module semantics, all covered by `test/pen.mjs`:

- import by **stem** (`"lib"`), not by file name (`"lib.uc"` won't resolve);
- `require("name")` compiles the file as a plain script, so it rejects files
  that use `export` -- use `import` for those;
- `export default function f() {}` is rejected by the compiler, `function f()
  {} export default f;` works;
- a `.uc` file without exports is treated as a script and runs automatically,
  so a library file needs at least one `export` to stay inert.

## Sharing and storage

- **copy link** encodes the whole pen (deflate + base64url) into `#p=...`, so
  the link works from any static host. A pen already saved on the server shares
  as `/p/<id>` instead.
- **save pen** stores it via the API when one is reachable, otherwise in
  `localStorage`.
- **download .json / load .json**, or drop a `.json` pen file anywhere on the
  page.

## Editor

A textarea with a syntax-highlighted `<pre>` underneath (line numbers, current
line, error line markers). Highlighting, top level declaration scanning and
error position mapping all come from the small lexer in `js/scan.js`; ucode,
template and JSON each get their own mode.

Failing steps are underlined in the editor with a wavy line at the reported
position, and hovering the line shows a tooltip with the full error message
(a custom one -- native `title=` tooltips take about a second to appear). The
console renders every failing step as a card: error type, file:line:byte link,
message, and the stack frames; every position is a click-to-jump link. Errors
are marked and reported while you type, but the caret is never moved or the
file switched on autorun -- moving around only happens when you click an error.

`Ctrl+Enter` runs, `Ctrl+S` saves, `Ctrl+/` toggles comments, `Ctrl+1..9`
switches files.

## Tests

```
node test/pen.mjs
```

Runs the real pipeline against `dist/ucode.js` -- shared scope, data parsing,
modules, template rendering, error reporting -- plus every built-in example.

