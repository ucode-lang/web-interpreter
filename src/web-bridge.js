// stderr capture for the web bridge (compiled into the glue via --pre-js).
//
// ucode's warn() and friends write to C's stderr. Emscripten's default
// printErr sends that to console.error, which is invisible inside the Web
// Worker that runs the pen. Instead, accumulate the text here; the JS side
// reads and clears it through Module.stderrText.
//
// Emscripten calls printErr once per line with the trailing newline
// stripped, so re-append it.

Module['stderrText'] = '';

// Emscripten's TTYs only emit on newline: a write without a trailing
// newline (e.g. warn("progress")) sits in the TTY's output buffer until the
// next newline or an explicit flush. flushTty() delivers (discard=false) or
// drops (discard=true) whatever is stuck, so partial lines are neither lost
// nor leaked into the next run. Each TTY is flushed through its own ops,
// which route the text to the right sink (err for /dev/stderr, out for
// /dev/stdout).
Module['flushTty'] = (discard) => {
	for (const tty of Object.values(TTY.ttys)) {
		if (!tty || !tty.output || tty.output.length === 0)
			continue;
		if (discard)
			tty.output = [];
		else
			tty.ops.fsync(tty);
	}
};

Module['printErr'] = (text) => {
    Module['stderrText'] += text + '\n';

    // keep it in the devtools console too, for debugging
    if (typeof console !== 'undefined')
        console.error(text);
};