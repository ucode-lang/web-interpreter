// A small code editor: a transparent <textarea> layered over a highlighted
// <pre>, with a line-number gutter.
//
// No dependencies, no contenteditable, and native undo keeps working because
// every programmatic edit goes through insertText. Re-highlighting the whole
// buffer on each keystroke is cheap at pen sizes (the lexer in scan.js is a
// single pass) and removes any need for incremental tokenising.

import { lex } from './scan.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Column width of a text run in a monospace font, honouring tab-size: 4. */
function columns(text) {
	let n = 0;

	for (const ch of text)
		n += ch === '\t' ? 4 - (n % 4) : 1;

	return n;
}

const UCODE_WORDS = new Set([
	'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'break',
	'continue', 'try', 'catch', 'throw', 'switch', 'case', 'default', 'do',
	'in', 'as', 'from', 'import', 'export', 'not', 'and', 'or', 'null', 'true',
	'false', 'delete', 'print', 'printf',
]);

const BUILTINS = new Set([
	'require', 'include', 'render', 'loadstring', 'loadfile', 'call', 'sprintf',
	'printf', 'json', 'length', 'keys', 'values', 'sort', 'map', 'filter',
	'split', 'join', 'substr', 'index', 'rindex', 'replace', 'match', 'regexp',
	'trim', 'ltrim', 'rtrim', 'push', 'pop', 'shift', 'unshift', 'splice',
	'slice', 'reverse', 'uniq', 'min', 'max', 'int', 'string', 'type', 'lc',
	'uc', 'time', 'clock', 'localtime', 'gmtime', 'sprintf', 'exists', 'assert',
	'die', 'warn', 'exit', 'proto', 'rawget', 'rawset', 'delete', 'b64enc',
	'b64dec', 'hex', 'hexdec', 'hexenc', 'ord', 'chr', 'system', 'sleep', 'gc',
]);

/** Highlight ucode source using the same lexer the pipeline runs on. */
function highlightUcode(src) {
	let out = '', at = 0;

	const gap = (to) => {
		if (to > at)
			out += esc(src.slice(at, to));
	};

	for (const t of lex(src)) {
		gap(t.i);

		const text = esc(t.s);

		if (t.t === 'comment')
			out += `<span class="t-comment">${text}</span>`;
		else if (t.t === 'string')
			out += `<span class="t-str">${text}</span>`;
		else if (t.t === 'regex')
			out += `<span class="t-re">${text}</span>`;
		else if (t.t === 'number')
			out += `<span class="t-num">${text}</span>`;
		else if (t.t === 'word') {
			if (UCODE_WORDS.has(t.s))
				out += `<span class="t-kw">${text}</span>`;
			else if (BUILTINS.has(t.s))
				out += `<span class="t-fn">${text}</span>`;
			else if (/^\s*\(/.test(src.slice(t.i + t.s.length)))
				out += `<span class="t-call">${text}</span>`;
			else
				out += text;
		}
		else
			out += `<span class="t-op">${text}</span>`;

		at = t.i + t.s.length;
	}

	gap(src.length);

	return out;
}

/**
 * ucode template mode: literal text plus {{ expression }}, {% statement %} and
 * {# comment #} tags. The code inside a tag is highlighted as ucode.
 */
function highlightTemplate(src) {
	const re = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})/g;
	let out = '', at = 0, m;

	while ((m = re.exec(src))) {
		out += `<span class="t-text">${esc(src.slice(at, m.index))}</span>`;

		const tag = m[0];

		if (tag.startsWith('{#'))
			out += `<span class="t-comment">${esc(tag)}</span>`;
		else if (tag.startsWith('{{'))
			out += `<span class="t-tpl">${esc(tag.slice(0, 2))}</span>${highlightUcode(tag.slice(2, -2))}<span class="t-tpl">${esc(tag.slice(-2))}</span>`;
		else
			out += `<span class="t-tpl">${esc(tag.slice(0, 2))}</span>${highlightUcode(tag.slice(2, -2))}<span class="t-tpl">${esc(tag.slice(-2))}</span>`;

		at = m.index + tag.length;
	}

	out += `<span class="t-text">${esc(src.slice(at))}</span>`;

	return out;
}

function highlightJson(src) {
	return esc(src)
		.replace(/("(?:[^"\\]|\\.)*")(\s*:)?/g, (_, s, colon) =>
			(colon ? `<span class="t-key">${s}</span>${colon}` : `<span class="t-str">${s}</span>`))
		.replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, '<span class="t-num">$1</span>')
		.replace(/\b(true|false|null)\b/g, '<span class="t-kw">$1</span>');
}

function highlightCsv(src) {
	return esc(src)
		.split('\n')
		.map((line, i) => (i === 0
			? `<span class="t-key">${line}</span>`
			: line.replace(/[^,]+/g, (v) => `<span class="t-str">${v}</span>`)))
		.join('\n');
}

export class Editor {
	constructor(host, { onChange, onRun, onSave, language = 'ucode' } = {}) {
		this.host = host;
		this.onChange = onChange;
		this.onRun = onRun;
		this.onSave = onSave;
		this.language = language;

		host.classList.add('editor-host');
		// The positioned wrapper belongs inside the host: making the host itself
		// absolutely positioned would take it out of the page's grid layout.
		host.innerHTML = `
			<div class="editor">
				<div class="editor-gutter"></div>
				<div class="editor-body">
					<div class="editor-marks"><div class="marks-inner"></div></div>
					<pre class="editor-hl" aria-hidden="true"></pre>
					<textarea class="editor-input" spellcheck="false" autocomplete="off"
						autocapitalize="off" wrap="off" placeholder="start typing"></textarea>
				</div>
			</div>`;

		this.gutter = host.querySelector('.editor-gutter');
		this.hl = host.querySelector('.editor-hl');
		this.input = host.querySelector('.editor-input');
		this.marksInner = host.querySelector('.marks-inner');

		this.input.addEventListener('input', () => this.#sync());
		this.input.addEventListener('keydown', (e) => this.#keydown(e));
		this.input.addEventListener('scroll', () => this.#scroll());
		this.input.addEventListener('click', () => this.#sync());
		this.input.addEventListener('keyup', () => this.#sync());
		this.input.addEventListener('blur', () => host.classList.remove('focused'));
		this.input.addEventListener('focus', () => host.classList.add('focused'));

		this.errorLine = null;
		this.marks = [];
		this.tip = null;
		this.tipLine = null;

		// Hovering an error line shows a tooltip. It is driven from the caret
		// geometry rather than from the marks layer (which is pointer-events:
		// none, sitting under a transparent textarea), so the whole line is a
		// hit area, gutter included. Native title= tooltips take ~1s to appear,
		// which is far too slow to read while editing, so this shows on the
		// hover event itself: no timer, and timers are throttled in background
		// tabs anyway.
		this.host.addEventListener('mousemove', (e) => this.#hover(e));
		this.host.addEventListener('mouseleave', () => this.#hideTip());
		this.input.addEventListener('keydown', () => this.#hideTip());
	}

	/** Line under a client Y coordinate, using the textarea's metrics. */
	#lineAt(clientY) {
		const rect = this.input.getBoundingClientRect();
		const pad = parseFloat(getComputedStyle(this.input).paddingTop) || 0;
		const lh = this.lineHeight();

		return Math.floor((clientY - rect.top - pad + this.input.scrollTop) / lh) + 1;
	}

	#hover(e) {
		const line = this.#lineAt(e.clientY);
		const mark = this.marks.find((m) => m.line === line);

		if (!mark) {
			this.#hideTip();

			return;
		}

		// re-entering the same line keeps the tooltip where it is, so sweeping
		// the mouse vertically does not make it jump around
		if (this.tipLine === line && this.tip && !this.tip.hidden)
			return;

		this.#showTip(mark, e.clientX, e.clientY);
	}

	#showTip(mark, x, y) {
		if (!this.tip) {
			this.tip = document.createElement('div');
			this.tip.className = 'editor-tip';
			this.tip.hidden = true;
			document.body.append(this.tip);
		}

		this.tip.replaceChildren();

		const head = document.createElement('div');

		head.append(this.#tipSpan('tip-type', mark.type || 'Error'));

		if (mark.label)
			head.append(this.#tipSpan('tip-where', mark.label));

		if (mark.where)
			head.append(this.#tipSpan('tip-at', mark.where));

		this.tip.append(head);

		const body = document.createElement('div');

		body.className = 'tip-msg';
		body.textContent = mark.detail || mark.message || 'error';
		this.tip.append(body);

		this.tip.hidden = false;
		this.tipLine = mark.line;

		const box = this.tip.getBoundingClientRect();
		const host = this.host.getBoundingClientRect();
		const left = Math.min(Math.max(8, x + 14), Math.max(8, host.right - box.width - 8));
		const below = y + 18;
		const top = below + box.height > window.innerHeight - 8 ? Math.max(8, y - box.height - 10) : below;

		this.tip.style.left = `${Math.round(left)}px`;
		this.tip.style.top = `${Math.round(top)}px`;
	}

	#tipSpan(kind, text) {
		const span = document.createElement('span');

		span.className = kind;
		span.textContent = text;

		return span;
	}

	#hideTip() {
		if (this.tip)
			this.tip.hidden = true;

		this.tipLine = null;
	}

	setLanguage(lang) {
		this.language = lang;
		this.#highlight();
	}

	getValue() {
		return this.input.value;
	}

	setValue(text, { keepUndo = true } = {}) {
		const value = text ?? '';

		if (keepUndo && document.activeElement === this.input) {
			this.input.select();
			this.#insert(value);
		}
		else {
			this.input.value = value;
		}

		this.#sync();
		this.input.scrollTop = 0;
		this.input.scrollLeft = 0;
	}

	focus() {
		this.input.focus();
	}

	/**
	 * Underline the offending positions of the open file: [{ line, column?,
	 * length?, message? }], or null/[] to clear. Marks survive editing because
	 * they are re-measured from the current text on every sync.
	 */
	setError(marks) {
		const next = (marks ?? []).filter((m) => m && m.line > 0);

		if (JSON.stringify(next) === JSON.stringify(this.marks))
			return;

		this.marks = next;
		this.errorLine = next.length ? next[0].line : null;
		this.#hideTip();
		this.#gutter();
		this.#marks();
	}

	revealLine(line, column = 1) {
		const total = this.input.value.split('\n').length;
		const target = Math.max(1, Math.min(line ?? 1, total));
		const lh = this.lineHeight();
		const offset = (target - 1) * lh;

		this.input.scrollTop = Math.max(0, offset - this.input.clientHeight / 3);

		const pos = this.input.value.split('\n').slice(0, target - 1).join('\n').length + (target > 1 ? 1 : 0);

		this.input.focus();
		this.input.setSelectionRange(pos + Math.max(0, (column ?? 1) - 1), pos + Math.max(0, (column ?? 1) - 1));
		this.#scroll();
	}

	lineHeight() {
		const cs = getComputedStyle(this.input);

		return parseFloat(cs.lineHeight) || 20;
	}

	get cursorLine() {
		return this.input.value.slice(0, this.input.selectionStart).split('\n').length;
	}

	get cursorColumn() {
		const col = this.input.selectionStart - this.input.value.lastIndexOf('\n', this.input.selectionStart - 1);

		return col;
	}

	#insert(text) {
		// insertText keeps the browser's native undo stack intact, unlike
		// assigning value or using setRangeText.
		if (!this.input.ownerDocument.execCommand('insertText', false, text)) {
			const s = this.input.selectionStart, e = this.input.selectionEnd;

			this.input.setRangeText(text, s, e, 'end');
			this.input.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}

	#replaceRange(start, end, text, selStart = null, selEnd = null) {
		this.input.setSelectionRange(start, end);
		this.#insert(text);

		if (selStart !== null)
			this.input.setSelectionRange(selStart, selEnd ?? selStart);
	}

	#lineBounds(pos) {
		const v = this.input.value;
		const start = v.lastIndexOf('\n', pos - 1) + 1;
		let end = v.indexOf('\n', pos);

		return [start, end < 0 ? v.length : end];
	}

	/** True when the caret sits inside a string literal or a comment. */
	#inStringOrComment(pos) {
		let last = null;

		for (const t of lex(this.input.value.slice(0, pos)))
			last = t;

		if (!last || last.t !== 'string' && last.t !== 'comment')
			return false;

		// something was typed after it, so the caret is no longer inside it
		if (last.i + last.s.length < pos)
			return false;

		if (last.t === 'comment')
			return last.s.startsWith('/*') ? !last.s.endsWith('*/') : true;

		const quote = last.s[0];

		// an unterminated token means the opening quote is still open
		return !(last.s.length >= 2 && last.s[last.s.length - 1] === quote);
	}

	#keydown(e) {
		const el = this.input;
		const mod = e.ctrlKey || e.metaKey;

		if (mod && e.key === 'Enter') {
			e.preventDefault();
			this.onRun?.();
			return;
		}

		if (mod && (e.key === 's' || e.key === 'S')) {
			e.preventDefault();
			this.onSave?.();
			return;
		}

		if (mod && e.key === '/') {
			e.preventDefault();
			this.toggleComment();
			return;
		}

		if (e.key === 'Tab') {
			e.preventDefault();
			this.#tab(e.shiftKey);
			return;
		}

		if (e.key === 'Enter' && !e.shiftKey && !mod) {
			if (this.#newline())
				e.preventDefault();

			return;
		}

		const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
		const closers = { ')': '(', ']': '[', '}': '{' };
		const plain = !mod && !e.altKey;

		// Typing a closing bracket right in front of the one that was inserted
		// automatically should step over it, not add a second one.
		if (plain && closers[e.key] && el.value[el.selectionStart] === e.key
			&& el.selectionStart === el.selectionEnd) {
			e.preventDefault();
			el.setSelectionRange(el.selectionStart + 1, el.selectionStart + 1);

			return;
		}

		if (plain && pairs[e.key]) {
			const close = pairs[e.key];
			const quote = close === e.key;
			const sel = el.value.slice(el.selectionStart, el.selectionEnd);
			const atCaret = el.value[el.selectionStart];

			// Inside a string or comment a quote never opens a new pair: either it
			// steps over the closer that was inserted automatically, or it is the
			// user's own text (JSON values are typed here constantly).
			if (quote && !sel && this.#inStringOrComment(el.selectionStart)) {
				if (atCaret === e.key) {
					e.preventDefault();
					el.setSelectionRange(el.selectionStart + 1, el.selectionStart + 1);
				}

				return;
			}

			e.preventDefault();

			if (sel)
				this.#insert(e.key + sel + close);
			else
				this.#insert(e.key + close);

			if (!sel)
				el.setSelectionRange(el.selectionStart - 1, el.selectionStart - 1);

			return;
		}

		if (e.key === 'Backspace' && !mod) {
			const i = el.selectionStart;

			if (i === el.selectionEnd && i > 0) {
				const before = el.value[i - 1], after = el.value[i];
				const openers = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

				if (openers[before] === after) {
					e.preventDefault();
					this.#replaceRange(i - 1, i + 1, '');

					return;
				}
			}
		}
	}

	#tab(shift) {
		const el = this.input;
		const s = el.selectionStart, e = el.selectionEnd;
		const value = el.value;

		if (s === e && !shift) {
			const [, lineStart] = [0, this.#lineBounds(s)[0]];
			const col = s - lineStart;
			const toNext = 4 - (col % 4);

			this.#insert(' '.repeat(toNext));

			return;
		}

		const [ls] = this.#lineBounds(s);
		let le = this.#lineBounds(e)[1];

		if (value.slice(e, le).trim() === '' && e !== ls)
			le = this.#lineBounds(Math.max(ls, e - 1))[1];

		const block = value.slice(ls, le);
		const lines = block.split('\n');
		let delta = 0;

		const next = lines.map((line, i) => {
			if (shift) {
				const cut = line.match(/^ {1,4}|\t/)?.[0].length ?? 0;

				if (i === 0)
					delta = -cut;

				return line.slice(cut);
			}

			if (line.trim() === '')
				return line;

			if (i === 0)
				delta = 4;

			return `    ${line}`;
		}).join('\n');

		this.#replaceRange(ls, le, next, ls, ls + next.length);
	}

	/** Enter with auto-indent; returns true when it handled the key. */
	#newline() {
		const el = this.input;
		const s = el.selectionStart;
		const value = el.value;
		const [lineStart] = this.#lineBounds(s);
		const indent = value.slice(lineStart, s).match(/^[\t ]*/)[0];
		const before = value.slice(0, s).trimEnd();
		const after = value.slice(el.selectionEnd).trimStart();
		const opens = /[{([]$/.test(before);
		const closesNext = /^[)\]}]/.test(after);

		if (!opens && !indent)
			return false;

		const step = '    ';
		const text = opens ? `\n${indent}${step}${closesNext ? `\n${indent}` : ''}` : `\n${indent}`;
		const caret = s + text.length - (closesNext && opens ? indent.length + 1 : 0);

		this.#insert(text);
		el.setSelectionRange(caret, caret);

		return true;
	}

	toggleComment() {
		const el = this.input;
		const marks = this.language === 'template' ? ['{# ', ' #}'] : ['// ', ''];
		const [startLine] = this.#lineBounds(el.selectionStart);
		const [endLine] = this.#lineBounds(el.selectionEnd);
		const block = el.value.slice(startLine, endLine);
		const lines = block.split('\n');
		const prefix = marks[0];

		const allCommented = lines.every((l) => l.trim() === '' || l.trimStart().startsWith(prefix.trimStart()));
		const next = lines.map((line) => {
			if (line.trim() === '')
				return line;

			if (allCommented) {
				const at = line.indexOf(prefix.trimStart());

				return at < 0 ? line : line.slice(0, at) + line.slice(at + prefix.trimStart().length);
			}

			const indent = line.match(/^[\t ]*/)[0];

			return indent + prefix + line.slice(indent.length) + marks[1];
		}).join('\n');

		this.#replaceRange(startLine, endLine, next, startLine, startLine + next.length);
	}

	#scroll() {
		this.hl.scrollTop = this.input.scrollTop;
		this.hl.scrollLeft = this.input.scrollLeft;
		this.gutter.scrollTop = this.input.scrollTop;
		this.marksInner.style.transform = `translate(${-this.input.scrollLeft}px, ${-this.input.scrollTop}px)`;
		this.#hideTip();
	}

	#gutter() {
		const lines = this.input.value.split('\n').length;
		const byLine = new Map(this.marks.map((m) => [m.line, m]));
		const out = [];

		for (let i = 1; i <= lines; i++) {
			const mark = byLine.get(i);

			out.push(`<div class="ln${mark ? ' err' : ''}">${i}</div>`);
		}

		this.gutter.innerHTML = out.join('');
	}

	/*
	 * The wavy underline lives in its own layer, translated with the textarea
	 * instead of being part of the highlighted text: the overlay must not shift
	 * a single glyph, and a compiler that points at the end of a line still
	 * deserves a visible mark.
	 */
	#marks() {
		const lines = this.input.value.split('\n');
		const byLine = new Map(this.marks.map((m) => [m.line, m]));
		const out = [];

		for (let i = 1; i <= lines.length; i++) {
			const mark = byLine.get(i);

			if (!mark) {
				out.push('<div class="mk"></div>');
				continue;
			}

			const text = lines[i - 1].replace(/[\t ]+$/, '');
			const at = Math.max(0, Math.min((mark.column ?? 1) - 1, Math.max(0, columns(text) - 1)));
			const to = Math.max(at + 1, columns(text), mark.length ? at + mark.length : 0);

			out.push(`<div class="mk err"><span style="margin-left:${at}ch;width:${to - at}ch"></span></div>`);
		}

		this.marksInner.innerHTML = out.join('');
		this.#scroll();
	}

	#highlight() {
		const src = this.input.value;
		let html;

		if (this.language === 'template')
			html = highlightTemplate(src);
		else if (this.language === 'ucode')
			html = highlightUcode(src);
		else if (this.language === 'json')
			html = highlightJson(src);
		else if (this.language === 'csv')
			html = highlightCsv(src);
		else
			html = esc(src);

		// A trailing newline keeps the overlay's scroll height in step with the
		// textarea, which renders one extra empty line after a final \n.
		this.hl.innerHTML = html + (src.endsWith('\n') ? '\n ' : '');
	}

	#sync() {
		this.#highlight();
		this.#gutter();
		this.#marks();
		this.#scroll();
		this.onChange?.();
	}
}