// ucode source scanning: a small hand written lexer plus a pass that finds the
// names a script declares at top level.
//
// Why this exists: ucode keeps top level `let`/`const`/`function` as locals of
// the program's main function, so they are invisible to any other program --
// including the templates that need them. The runner executes every script of a
// pen with one shared scope object, and the UI appends a footer to each script
// that copies its top level names into that object:
//
//     if (__pen_scope != null) {
//         __pen_scope.greeting = greeting;
//         __pen_scope.items = items;
//     }
//
// The scan only has to be conservative in one direction: a name it misses is a
// name a template cannot see (a plain "undefined" in the output), never a
// broken run. A name it invents would be a compile error though, so the lexer
// is careful about strings, comments and regular expressions.

const ID_START = /[A-Za-z_]/;
const ID_PART = /[A-Za-z0-9_]/;

// ucode keywords and literals -- never valid as `name` on the right of a `.`
export const KEYWORDS = new Set([
	'break', 'case', 'catch', 'const', 'continue', 'default', 'delete', 'do',
	'else', 'export', 'for', 'foreach', 'function', 'if', 'import', 'in', 'let',
	'not', 'null', 'print', 'printf', 'return', 'switch', 'try', 'catch',
	'while', 'as', 'from', 'then', 'true', 'false',
]);

// A `/` starts a regular expression (instead of a division) when the previous
// token cannot end an operand.
function regexCanStart(prev) {
	if (!prev)
		return true;

	if (prev.t === 'word')
		return !/^(true|false|null)$/.test(prev.s);

	return prev.t === 'open' || prev.t === 'semi' || prev.t === 'comma' ||
	       prev.t === 'punct' || prev.t === 'comment';
}

function skipQuoted(src, i) {
	const quote = src[i];
	i++;

	while (i < src.length) {
		if (src[i] === '\\') {
			i += 2;
			continue;
		}

		if (src[i] === quote)
			return i + 1;

		i++;
	}

	return i;
}

// Backtick template literal. ${ ... } holds real code, which may itself contain
// strings, so brace depth has to be tracked while skipping it.
function skipTemplate(src, i) {
	i++;

	while (i < src.length) {
		if (src[i] === '\\') {
			i += 2;
			continue;
		}

		if (src[i] === '`')
			return i + 1;

		if (src[i] === '$' && src[i + 1] === '{') {
			let depth = 1;

			i += 2;

			while (i < src.length && depth > 0) {
				const c = src[i];

				if (c === '"' || c === "'") {
					i = skipQuoted(src, i);
					continue;
				}

				if (c === '`') {
					i = skipTemplate(src, i);
					continue;
				}

				if (c === '{')
					depth++;
				else if (c === '}')
					depth--;

				i++;
			}

			continue;
		}

		i++;
	}

	return i;
}

function skipRegex(src, i) {
	i++;
	let inClass = false;

	while (i < src.length) {
		const c = src[i];

		if (c === '\\') {
			i += 2;
			continue;
		}

		if (c === '[')
			inClass = true;
		else if (c === ']')
			inClass = false;
		else if (c === '/' && !inClass) {
			i++;

			while (i < src.length && /[a-z]/.test(src[i]))
				i++;

			return i;
		}
		else if (c === '\n')
			return i;	// not a regex after all

		i++;
	}

	return i;
}

/**
 * Split ucode source into significant tokens.
 *
 * Yields { t, s, i, depth, nl } where t is one of word, number, string, regex,
 * comment, open, close, semi, comma, punct, nl says whether a newline came
 * before the token and depth is the brace/paren/bracket nesting level the
 * token sits at (0 == top level).
 */
export function* lex(src) {
	let i = 0, depth = 0, nl = false, prev = null;
	const n = src.length;

	const emit = (t, s, at) => {
		const tok = { t, s, i: at, depth, nl };

		nl = false;
		prev = tok;

		return tok;
	};

	while (i < n) {
		const c = src[i];

		if (c === '\n') {
			nl = true;
			i++;
			continue;
		}

		if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
			i++;
			continue;
		}

		if (c === '/' && src[i + 1] === '/') {
			const j = src.indexOf('\n', i);
			const to = j < 0 ? n : j;

			yield emit('comment', src.slice(i, to), i);
			i = to;
			continue;
		}

		if (c === '/' && src[i + 1] === '*') {
			const j = src.indexOf('*/', i + 2);
			const to = j < 0 ? n : j + 2;

			yield emit('comment', src.slice(i, to), i);
			i = to;
			continue;
		}

		if (c === '"' || c === "'") {
			const j = skipQuoted(src, i);

			yield emit('string', src.slice(i, j), i);
			i = j;
			continue;
		}

		if (c === '`') {
			const j = skipTemplate(src, i);

			yield emit('string', src.slice(i, j), i);
			i = j;
			continue;
		}

		if (c === '/' && regexCanStart(prev)) {
			const j = skipRegex(src, i);

			if (j > i + 1) {
				yield emit('regex', src.slice(i, j), i);
				i = j;
				continue;
			}
		}

		if (/[0-9]/.test(c)) {
			let j = i + 1;

			while (j < n && /[0-9a-fA-FxXoObBeE._]/.test(src[j]))
				j++;

			yield emit('number', src.slice(i, j), i);
			i = j;
			continue;
		}

		if (ID_START.test(c)) {
			let j = i + 1;

			while (j < n && ID_PART.test(src[j]))
				j++;

			yield emit('word', src.slice(i, j), i);
			i = j;
			continue;
		}

		if (c === '(' || c === '[' || c === '{') {
			yield emit('open', c, i);
			depth++;
			i++;
			continue;
		}

		if (c === ')' || c === ']' || c === '}') {
			depth--;
			yield emit('close', c, i);
			i++;
			continue;
		}

		if (c === ';') {
			yield emit('semi', c, i);
			i++;
			continue;
		}

		if (c === ',') {
			yield emit('comma', c, i);
			i++;
			continue;
		}

		yield emit('punct', c, i);
		i++;
	}
}

// Statement keywords that end a `let` declarator list when no semicolon was
// used (ucode has no automatic semicolon insertion, but a block's last
// statement is allowed to run into the closing brace).
const STMT_WORDS = new Set([
	'let', 'const', 'function', 'if', 'for', 'while', 'return', 'try',
	'import', 'export', 'switch', 'break', 'continue', 'print', 'printf',
	'delete', 'throw',
]);

/**
 * Names declared at the top level of a raw-mode ucode script.
 *
 * Handles `let a = 1, b = 2` and `function f() {}`. Destructuring does not
 * exist in ucode, so a declarator is always a single identifier.
 */
export function topLevelDecls(src) {
	const toks = [...lex(src)];
	const names = [];

	for (let k = 0; k < toks.length; k++) {
		const t = toks[k];

		if (t.depth !== 0 || t.t !== 'word')
			continue;

		if (t.s === 'function') {
			const next = toks[k + 1];

			if (next && next.t === 'word' && !KEYWORDS.has(next.s))
				names.push(next.s);

			continue;
		}

		if (t.s !== 'let' && t.s !== 'const' && t.s !== 'import')
			continue;

		// import { a, b as c } from "mod" / import * as ns from "mod": the
		// imported names are top level bindings too, so templates may use them.
		if (t.s === 'import') {
			let j = k + 1;
			let expectAlias = false;

			while (j < toks.length) {
				const u = toks[j];

				if (u.depth === 0 && (u.t === 'semi' || (u.t === 'word' && u.s === 'from')))
					break;

				if (u.t === 'word') {
					if (u.s === 'as')
						expectAlias = true;
					else if (expectAlias || !KEYWORDS.has(u.s)) {
						names.push(u.s);
						expectAlias = false;
					}
				}

				j++;
			}

			k = j - 1;
			continue;
		}

		let expectName = true;

		for (let j = k + 1; j < toks.length; j++) {
			const u = toks[j];

			if (u.depth < 0)
				break;

			if (u.depth > 0)
				continue;

			if (u.t === 'semi')
				break;

			if (u.t === 'comma') {
				expectName = true;
				continue;
			}

			if (u.t !== 'word')
				continue;

			if (STMT_WORDS.has(u.s))
				break;

			if (expectName && !KEYWORDS.has(u.s)) {
				names.push(u.s);
				expectName = false;
			}
		}
	}

	return [...new Set(names)].filter((n) => !n.startsWith('__'));
}

/**
 * True when the source has a top level `export`, i.e. it is a ucode module
 * rather than a script. Such a file cannot be executed as a plain program
 * ("Exports may only appear at top level of a module"), so the manifest leaves
 * it out of the script list and it is only ever reached through
 * require("name") / import { x } from "name".
 */
export function hasTopLevelExport(src) {
	for (const t of lex(src)) {
		if (t.depth === 0 && t.t === 'word' && t.s === 'export')
			return true;
	}

	return false;
}

/**
 * Source to append to a script so that its top level names end up in the pen's
 * shared scope object.
 *
 * The leading `;` matters: ucode has no automatic semicolon insertion, so a
 * script whose last statement is unterminated would otherwise run into the
 * appended `if`. The `!= null` test keeps the footer inert when a file is
 * loaded as a module (require/import), where no shared scope exists.
 */
export function publishFooter(names) {
	const safe = [...new Set(names)].filter(
		(n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORDS.has(n) && !n.startsWith('__')
	);

	if (!safe.length)
		return '';

	return '\n;\nif (__pen_scope != null) {\n' +
		safe.map((n) => `\t__pen_scope.${n} = ${n};`).join('\n') +
		'\n}\n';
}

/**
 * Byte offset -> { line, column } (both 1 based), for error links.
 */
export function locate(src, offset) {
	const upto = src.slice(0, Math.max(0, Math.min(offset, src.length)));
	const line = upto.split('\n').length;
	const column = offset - (upto.lastIndexOf('\n') + 1) + 1;

	return { line, column };
}