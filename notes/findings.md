# Findings (driving the pen design)

- `render(path, scope)` (core) renders a template file, captures output as string.
  scope object WITH a prototype is used as-is (no copy) -> `proto(obj, global)` trick.
- `call(fn, this, scope, ...)`: if scope has a prototype, it is used directly as the
  program's scope object -> top-level `let`/`const`/`function` of a loadfile()d
  program LAND IN THAT OBJECT. This is how .uc scripts share state with .ut templates.
- Top-level `let` in a program run via uc_vm_execute is a local of the program's
  main function, NOT a VM global: only bare `x = 1` assignments persist across runs.
- Template mode = compile with raw_mode=false (+lstrip_blocks/trim_blocks).
- loadfile()/loadstring(src, {raw_mode:false}) compile at runtime.
- BUG in existing bridge: run_source() hands the JS _malloc'd pointer to
  uc_source_new_buffer(), which takes ownership and free()s it in types.c:371,
  while the JS caller also _free()s it -> double free. Fix: strdup inside.
- BUG: ucode_get_output() truncates at 8192 bytes (static buffer).
- TCO: `function f(n){return f(n+1)}` compiles to a loop -> endless loop, no stack
  overflow. Infinite loops must be killed from outside => run WASM in a Web Worker
  and terminate() it on timeout.
- Module search path /virtual/*.uc is writable via MEMFS -> pen files can be
  `require`d as ucode source modules.
