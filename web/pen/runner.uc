// ucodepen execution kernel.
//
// The browser UI mirrors the editor buffers into the virtual filesystem under
// /pen/, drops a manifest at /pen/.pen.json and then runs this file with
// ucode_run_file(). What happens, in order:
//
//   1. the data files are loaded into DATA (.json parsed, .csv/.tsv
//      tabulated, everything else kept as text) and PEN.raw / PEN.lines
//   2. every .uc script runs, in manifest order, inside one shared scope
//   3. every .ut template is rendered against that same scope
//   4. the rendered documents and a JSON report are written to /pen/.out/
//
// The shared scope is what makes the whole thing feel like CodePen. ucode
// keeps top level `let`/`function` as locals of the program's main function,
// so they are normally invisible to anything else. The UI therefore appends a
// short footer to each script that publishes its top level names into
// `__pen_scope`, and call(fn, null, scope) runs every script with that very
// object as its scope. A template rendered with render(path, scope) then sees
// `greeting`, `items()` and friends as plain names -- no exports, no globals,
// no boilerplate.

let fs = require("fs");

let PEN_ROOT = "/pen";
let PEN_OUT = PEN_ROOT + "/.out";
let PEN_META = PEN_ROOT + "/.pen.json";

// ------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------

function read_or(path, fallback) {
    let s = fs.readfile(path);

    return s == null ? fallback : s;
}

function now_ms() {
    let t = clock();

    return t[0] * 1000 + t[1] / 1000000;
}

function basename(path) {
    let parts = split(path, "/");

    return parts[length(parts) - 1];
}

// "people.json" -> "people"
function stem(name) {
    let base = basename(name);
    let dot = rindex(base, ".");

    return dot > 0 ? substr(base, 0, dot) : base;
}

// "my data.json" -> "my_data" (a usable ucode property name)
function ident(name) {
    let s = lc(stem(name));
    let out = "";

    for (let i = 0; i < length(s); i = i + 1)
        out = out + (length(match(substr(s, i, 1), /^[a-z0-9_]$/)) > 0 ? substr(s, i, 1) : "_");

    if (length(match(substr(out, 0, 1), /^[0-9]$/)) > 0)
        out = "_" + out;

    return out;
}

function file_ext(name) {
    let base = basename(name);
    let dot = rindex(base, ".");

    return dot < 0 ? "" : lc(substr(base, dot + 1));
}

// Minimal RFC4180-ish CSV reader: quoted fields, "" escapes, \r\n or \n.
// Returns an array of rows (arrays of strings).
function csv_rows(text) {
    let rows = [], row = [], field = "", quoted = false;
    let i = 0, c, n = length(text);

    while (i < n) {
        c = substr(text, i, 1);

        if (quoted) {
            if (c == "\"") {
                if (i + 1 < n && substr(text, i + 1, 1) == "\"") {
                    field = field + "\"";
                    i = i + 1;
                }
                else
                    quoted = false;
            }
            else
                field = field + c;
        }
        else if (c == "\"" && field == "")
            quoted = true;
        else if (c == ",") {
            row[length(row)] = field;
            field = "";
        }
        else if (c == "\n" || c == "\r") {
            if (c == "\r" && i + 1 < n && substr(text, i + 1, 1) == "\n")
                i = i + 1;

            row[length(row)] = field;
            rows[length(rows)] = row;
            row = [];
            field = "";
        }
        else
            field = field + c;

        i = i + 1;
    }

    if (field != "" || length(row) > 0) {
        row[length(row)] = field;
        rows[length(rows)] = row;
    }

    return rows;
}

// Turn a data file into a ucode value:
//   .json -> parsed JSON
//   .csv  -> array of objects keyed by the header row
//   .tsv  -> ditto, tab separated
//   else  -> the raw text
function parse_data(ext, text) {
    if (ext == "json") {
        return json(text);
    }
    else if (ext == "csv" || ext == "tsv") {
        let sep = ext == "csv" ? "," : "\t";
        let rows = [];
        let raw_rows = csv_rows(sep == "," ? text : replace(text, "\t", ","));
        let head = length(raw_rows) > 0 ? raw_rows[0] : [];
        let out = [];

        for (let r = 1; r < length(raw_rows); r = r + 1) {
            if (length(raw_rows[r]) == 1 && trim(raw_rows[r][0]) == "")
                continue;

            let obj = {};

            for (let c = 0; c < length(head); c = c + 1)
                obj[trim(head[c])] = c < length(raw_rows[r]) ? raw_rows[r][c] : "";

            out[length(out)] = obj;
        }

        return out;
    }

    return text;
}

function exception_info(e) {
    let info = {
        type: e && e.type ? e.type : "Error",
        message: e && e.message ? e.message : "" + e,
        frames: [],
    };

    if (e && e.stacktrace) {
        for (let i = 0; i < length(e.stacktrace) && i < 12; i = i + 1) {
            let f = e.stacktrace[i];

            info.frames[length(info.frames)] = {
                file: f.filename,
                line: f.line,
                byte: f.byte,
                function: f.function,
                context: f.context,
            };
        }
    }

    return info;
}

// ------------------------------------------------------------------
// manifest
// ------------------------------------------------------------------

let meta_text = read_or(PEN_META, null);

if (meta_text == null) {
    print("ucodepen: missing manifest " + PEN_META + "\n");
    return false;
}

let meta = json(meta_text);

if (meta == null) {
    print("ucodepen: manifest is not valid JSON\n");
    return false;
}

if (meta.scripts == null)
    meta.scripts = [];

if (meta.templates == null)
    meta.templates = [];

if (meta.data == null)
    meta.data = [];

if (meta.files == null)
    meta.files = [];

let report = {
    ok: true,
    steps: [],
    outputs: [],
    started: time(),
};

fs.mkdir(PEN_OUT);

function step(kind, name, fn) {
    let entry = { kind: kind, name: name, ok: true };
    let t0 = now_ms();

    try {
        entry.result = fn();
    }
    catch (e) {
        entry.ok = false;
        entry.error = exception_info(e);
        report.ok = false;
    }

    entry.ms = now_ms() - t0;
    report.steps[length(report.steps)] = entry;

    return entry;
}

// ------------------------------------------------------------------
// 1. data files
// ------------------------------------------------------------------

let DATA = {};
let raw = {};
let lines = {};

for (let i = 0; i < length(meta.data); i = i + 1) {
    let d = meta.data[i];
    let text = read_or(PEN_ROOT + "/" + d.path, "");
    let key = d.key || ident(d.path);

    raw[key] = text;
    lines[key] = split(trim(text, " \t\r\n"), "\n");

    step("data", d.path, function () {
        DATA[key] = parse_data(file_ext(d.path), text);
        return null;
    });
}

// ------------------------------------------------------------------
// 2. the pen object and the shared scope
// ------------------------------------------------------------------

// The shared scope and the pen object start out empty and are filled in below.
// ucode refuses to compile a closure that mentions a lexical declaration which
// is still being initialised, and nearly every pen helper closes over both
// objects -- so `let PEN = { read: function () { PEN... } }` is a syntax error.
//
// A scope object that already carries a prototype is used verbatim by call()
// and render(), so everything the scripts publish lands right here.
let scope = {};
let PEN = {};

PEN.name = meta.name;
PEN.files = [];
PEN.scripts = [];
PEN.templates = [];
PEN.data = [];
PEN.modules = [];
PEN.raw = raw;
PEN.lines = lines;
PEN.root = PEN_ROOT;

// read a project file as text: pen.read("data/notes.txt")
PEN.read = function (rel) {
    return read_or(PEN_ROOT + "/" + rel, "");
};

// list the project files, optionally only those under a prefix
PEN.list = function (prefix) {
    let out = [];

    for (let i = 0; i < length(PEN.files); i = i + 1)
        if (prefix == null || index(PEN.files[i], prefix) == 0)
            out[length(out)] = PEN.files[i];

    return out;
};

// HTML-escape a value. ucode templates do not autoescape, so this is the
// conventional helper -- kept short so templates stay readable.
PEN.esc = function (v) {
    return replace(replace(replace(replace("" + v,
        "&", "&amp;"), "<", "&lt;"), ">", "&gt;"), "\"", "&quot;");
};

// Run another .uc file of the pen in a child scope and return that scope:
//     let h = pen.use("fmt")   ->   h.money(99)
// The child inherits the pen scope, so the loaded file sees DATA, PEN and
// everything the scripts published, while its own top level names stay
// contained in the returned object.
PEN.use = function (name) {
    let file = match(name, /\.uc$/) ? name : name + ".uc";
    let path = PEN_ROOT + "/" + file;
    let child = { PEN: PEN, pen: PEN, DATA: DATA };

    proto(child, scope);

    child.__pen_scope = child;

    let fn = loadfile(path);

    if (fn == null)
        die("cannot load " + path);

    call(fn, null, child);

    return child;
};

// Emit an extra output document from a script, alongside the rendered
// templates: pen.out("report.txt", sprintf("%.2f", x))
PEN.out = function (name, body) {
    let target = PEN_OUT + "/x" + length(report.outputs) + ".out";

    fs.writefile(target, "" + body);
    report.outputs[length(report.outputs)] = {
        name: name,
        path: target,
        bytes: length(body),
    };

    return target;
};

for (let i = 0; i < length(meta.files); i = i + 1)
    PEN.files[length(PEN.files)] = meta.files[i].path;

for (let i = 0; i < length(meta.scripts); i = i + 1)
    PEN.scripts[length(PEN.scripts)] = meta.scripts[i];

for (let i = 0; i < length(meta.templates); i = i + 1)
    PEN.templates[length(PEN.templates)] = meta.templates[i];

for (let i = 0; i < length(meta.data); i = i + 1)
    PEN.data[length(PEN.data)] = meta.data[i].path;

scope.PEN = PEN;
scope.pen = PEN;
scope.DATA = DATA;

proto(scope, global);

scope.__pen_scope = scope;

// ------------------------------------------------------------------
// 3. scripts
// ------------------------------------------------------------------

let failed = false;

// Snapshot the global scope so the inspector can tell the user which names
// their scripts created: a bare `x = 1` at top level lands in the global scope
// (templates see it through the scope chain), while `let x = 1` only reaches it
// through the publish footer.
let globals_before = sort(keys(global));

// Register the pen's own scripts in the module table before running any of
// them: require("main") / import ... from "main" then resolve to the live
// shared scope instead of compiling the file a second time in global scope.
// Library files (not listed as scripts) keep the usual module semantics --
// they are compiled from /pen/*.uc and expose whatever they `export`.
for (let i = 0; i < length(meta.scripts); i = i + 1)
    modules[stem(meta.scripts[i])] = scope;

// The manifest's module list: files with a top level export. They are NOT
// registered in `modules` here -- that would make import { x } from "lib"
// resolve to the scope object instead of compiling the module, and ucode
// rejects `export` outside module mode. They stay reachable through the
// /pen/*.uc search path entry.
for (let i = 0; i < length(meta.modules); i = i + 1)
    PEN.modules[length(PEN.modules)] = meta.modules[i];

for (let i = 0; i < length(meta.scripts); i = i + 1) {
    let name = meta.scripts[i];
    let path = PEN_ROOT + "/" + name;

    let entry = step("script", name, function () {
        let fn = loadfile(path);

        if (fn == null)
            die("cannot load " + path);

        call(fn, null, scope);

        return null;
    });

    if (!entry.ok) {
        failed = true;
        break;
    }
}

// ------------------------------------------------------------------
// 4. templates
// ------------------------------------------------------------------

if (!failed) {
    for (let i = 0; i < length(meta.templates); i = i + 1) {
        let name = meta.templates[i];
        let path = PEN_ROOT + "/" + name;

        step("template", name, function () {
            let body = render(path, scope);
            let target = PEN_OUT + "/" + sprintf("%02d", i) + ".out";

            fs.writefile(target, body);

            report.outputs[length(report.outputs)] = {
                name: name,
                path: target,
                bytes: length(body),
            };

            return null;
        });

        if (!report.ok)
            break;
    }
}
else {
    report.skipped = length(meta.templates);
}

report.finished = time();

// ------------------------------------------------------------------
// 5. inspector: what the templates can actually see
// ------------------------------------------------------------------

function preview(v) {
    let t = type(v);

    if (t == "string")
        return length(v) > 80 ? substr(v, 0, 80) + "..." : v;

    if (t == "array")
        return "[" + length(v) + " items]";

    if (t == "object") {
        let ks = sort(keys(v));

        return "{ " + join(", ", slice(ks, 0, 8)) + (length(ks) > 8 ? ", ..." : "") + " }";
    }

    if (t == "null")
        return "null";

    if (length("" + v) > 80)
        return substr("" + v, 0, 80) + "...";

    return "" + v;
}

let inspect = { data: [], names: [] };

for (let k in sort(keys(DATA)))
    inspect.data[length(inspect.data)] = {
        name: k, type: type(DATA[k]), preview: preview(DATA[k]),
    };

for (let k in sort(keys(scope))) {
    if (k == "__pen_scope" || k == "PEN" || k == "pen" || k == "DATA")
        continue;

    inspect.names[length(inspect.names)] = {
        name: k, type: type(scope[k]), preview: preview(scope[k]), where: "pen",
    };
}

// names the scripts assigned without declaring them (bare `x = ...`)
for (let k in sort(keys(global))) {
    if (index(globals_before, k) >= 0 || k == "modules" || k == "REQUIRE_SEARCH_PATH")
        continue;

    inspect.names[length(inspect.names)] = {
        name: k, type: type(global[k]), preview: preview(global[k]), where: "global",
    };
}

fs.writefile(PEN_OUT + "/inspect.json", sprintf("%J", inspect));

// ------------------------------------------------------------------
// 6. report
// ------------------------------------------------------------------

fs.writefile(PEN_OUT + "/report.json", sprintf("%J", report));

return report.ok;