// Thin, synchronous wrapper around the exported C API of ucode.wasm.
//
// Everything here is deliberately dumb -- one method per bridge call, strings
// marshalled through wasm memory -- so that the same wrapper drives the
// interpreter in a Web Worker (browser) and in a plain node process (tests).
//
// The C side keeps ownership of every buffer it returns; the strings are only
// valid until the next call to the same getter, which is why each method reads
// the buffer out into a JS string immediately.

export function makeBridge(M) {
	const scratch = [];

	// The build exports UTF8ToString / lengthBytesUTF8 / stringToUTF8 but not
	// HEAPU8, so strings are marshalled with those (see README: passing pointers
	// into wasm memory is also what sidesteps emscripten's automatic JS->C
	// conversion, which is unreliable after the module's initial run).
	const write = (text) => {
		const s = String(text ?? '');
		const len = M.lengthBytesUTF8(s);
		const ptr = M._malloc(len + 1);

		M.stringToUTF8(s, ptr, len + 1);
		scratch.push(ptr);

		return { ptr, len };
	};

	const freeAll = () => {
		while (scratch.length)
			M._free(scratch.pop());
	};

	const str = (ptr) => (ptr ? M.UTF8ToString(ptr) : '');

	// Deliver text stuck in emscripten's TTY buffers (partial lines without a
	// trailing newline) to the JS-side capture after every run.
	const flushStdio = () => M.flushTty(false);

	const api = {
		module: M,

		/** number of statically linked ucode modules */
		moduleCount: () => M._ucode_module_count(),

		/** drop the interpreter (globals, closures, module cache), keep the fs;
		 *  also discards any text stuck in the TTY buffers so a re-run starts
		 *  with clean stdio */
		reset: () => { M._ucode_reset(); M.flushTty(true); M.stderrText = ''; },

		/** create or overwrite a file in the virtual filesystem */
		writeFile(path, content) {
			const p = write(path);
			const d = write(content);
			const rc = M._ucode_vfs_write(p.ptr, d.ptr, d.len);

			freeAll();

			return rc === 0;
		},

		removeFile(path) {
			const p = write(path);
			const rc = M._ucode_vfs_remove(p.ptr);

			freeAll();

			return rc === 0;
		},

		/** recursive delete of a directory tree */
		clearDir(root) {
			const p = write(root);
			const rc = M._ucode_vfs_clear(p.ptr);

			freeAll();

			return rc === 0;
		},

		/** [{path, type, size}] */
		listDir(root) {
			const p = write(root);

			try {
				return JSON.parse(str(M._ucode_vfs_list(p.ptr)) || '[]');
			}
			catch {
				return [];
			}
			finally {
				freeAll();
			}
		},

		readFile(path) {
			const p = write(path);

			try {
				return str(M._ucode_fs_read(p.ptr));
			}
			finally {
				freeAll();
			}
		},

		/** run a file of the virtual filesystem as a ucode script */
		runFile(path) {
			const p = write(path);

			try {
				M._ucode_run_file(p.ptr);
			}
			finally {
				freeAll();
			}

			flushStdio();

			return { output: str(M._ucode_get_output()), error: str(M._ucode_get_error()) };
		},

		/** run a source string as a script (console stream) */
		run(source) {
			const p = write(source);

			try {
				M._ucode_run(p.ptr);
			}
			finally {
				freeAll();
			}

			flushStdio();

			return { output: str(M._ucode_get_output()), error: str(M._ucode_get_error()) };
		},

		/** run a source string as an expression, echoing the result */
		eval(source) {
			const p = write(source);

			try {
				M._ucode_eval(p.ptr);
			}
			finally {
				freeAll();
			}

			flushStdio();

			return { output: str(M._ucode_get_output()), error: str(M._ucode_get_error()) };
		},

		/** run a file with its output diverted to the render stream */
		renderFile(path, templateMode = true) {
			const p = write(path);

			try {
				M._ucode_render_file(p.ptr, templateMode ? 1 : 0);
			}
			finally {
				freeAll();
			}

			flushStdio();

			return {
				render: str(M._ucode_get_render()),
				error: str(M._ucode_get_error()),
			};
		},

		/** render a source string in template mode */
		render(source, templateMode = true) {
			const p = write(source);

			try {
				M._ucode_render_string(p.ptr, templateMode ? 1 : 0);
			}
			finally {
				freeAll();
			}

			flushStdio();

			return {
				render: str(M._ucode_get_render()),
				error: str(M._ucode_get_error()),
			};
		},

		output: () => str(M._ucode_get_output()),

		/** text written to C's stderr since the last reset (warn() and friends) */
		stderr: () => M.stderrText,

		/** deliver text stuck in the TTY buffers (partial lines) to the capture */
		flushStdio: () => M.flushTty(false),
		render: () => str(M._ucode_get_render()),
		error: () => str(M._ucode_get_error()),
		clearOutput: () => M._ucode_clear_output(),
		clearRender: () => M._ucode_clear_render(),

		/** seed the bundled /demo tree (used by the REPL page) */
		seedDemo: () => M._ucode_fs_seed_demo(),
	};

	return api;
}