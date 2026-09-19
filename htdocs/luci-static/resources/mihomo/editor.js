'use strict';
'require dom';

/*
 * A dependency-free YAML editor for the Mihomo panel.
 *
 * The editable surface is a plain <textarea>; a <pre> overlay underneath it
 * renders syntax highlighting, and a gutter next to it renders line numbers
 * and problem markers. Both are kept metrically identical to the textarea
 * (same font, padding, line height, no wrapping) and follow its scroll
 * position, so the browser keeps native selection, IME, undo/redo and
 * accessibility behaviour while the user sees a code-editor presentation.
 *
 * The line scanner below is a heuristic YAML tokenizer. It is intentionally
 * conservative: it highlights the common block/flow/scalar forms and only
 * reports problems that are certain to be rejected by a YAML parser.
 */

const INDENT = 2;
const HIGHLIGHT_LIMIT = 1024 * 1024;
const CACHE_LIMIT = 40000;
const PROBLEM_LIMIT = 200;

const NUMBER = /^[-+]?(?:\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.\d[\d_]*(?:[eE][-+]?\d+)?)$/;
const BOOLEAN = /^(?:true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF)$/;
const NULL = /^(?:null|Null|NULL|~)$/;
const BLOCK_INDICATOR = /^[|>](?:[-+][1-9]?|[1-9][-+]?)?$/;
const WORD_CHAR = /[A-Za-z0-9_\u00A0-\uFFFF]/;

const INITIAL_STATE = { block: -1, quote: '', flow: 0 };

function stateKey(state) {
	return state.block + ':' + state.quote + ':' + state.flow;
}

function escapeHTML(text) {
	return text.replace(/[&<>]/g, function(ch) {
		return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;';
	});
}

function emit(out, cls, text) {
	if (!text)
		return;
	out.push(cls ? '<span class="' + cls + '">' + escapeHTML(text) + '</span>' : escapeHTML(text));
}

function emitWhitespace(out, text) {
	if (!text)
		return;
	out.push(text.indexOf('\t') === -1 ? text : text.replace(/\t/g, '<span class="y-tab">\t</span>'));
}

function isBlank(ch) {
	return ch === ' ' || ch === '\t';
}

function skipBlanks(line, pos) {
	while (pos < line.length && isBlank(line[pos]))
		pos++;
	return pos;
}

function commentAt(line, pos) {
	return line[pos] === '#' && (pos === 0 || isBlank(line[pos - 1]));
}

function scanDoubleQuoted(line, pos) {
	for (let i = pos; i < line.length; i++) {
		if (line[i] === '\\') {
			i++;
			continue;
		}
		if (line[i] === '"')
			return i + 1;
	}
	return -1;
}

function scanSingleQuoted(line, pos) {
	for (let i = pos; i < line.length; i++) {
		if (line[i] === "'") {
			if (line[i + 1] === "'") {
				i++;
				continue;
			}
			return i + 1;
		}
	}
	return -1;
}

function scalarClass(text) {
	if (NUMBER.test(text))
		return 'y-num';
	if (BOOLEAN.test(text))
		return 'y-bool';
	if (NULL.test(text))
		return 'y-null';
	return 'y-str';
}

function unquoteKey(text) {
	if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
		try { return JSON.parse(text); }
		catch (ignored) { return text.slice(1, -1); }
	}
	if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'")
		return text.slice(1, -1).replace(/''/g, "'");
	return text;
}

/* Returns { keyEnd, colon, quoted } when a mapping key starts at pos. */
function matchKey(line, pos, flow) {
	const ch = line[pos];
	if (ch === '"' || ch === "'") {
		const end = ch === '"' ? scanDoubleQuoted(line, pos + 1) : scanSingleQuoted(line, pos + 1);
		if (end < 0)
			return null;
		let p = end;
		while (line[p] === ' ')
			p++;
		if (line[p] !== ':')
			return null;
		if (p + 1 >= line.length || isBlank(line[p + 1]) || flow)
			return { keyEnd: end, colon: p, quoted: true };
		return null;
	}
	if (ch === undefined || '[]{}#&*!|>%@`'.indexOf(ch) !== -1 || (flow && ch === ','))
		return null;
	for (let i = pos; i < line.length; i++) {
		const c = line[i];
		if (c === ':' && (i + 1 >= line.length || isBlank(line[i + 1]))) {
			let end = i;
			while (end > pos && line[end - 1] === ' ')
				end--;
			return { keyEnd: end, colon: i, quoted: false };
		}
		if (c === '#' && i > pos && isBlank(line[i - 1]))
			return null;
		if (flow && ',[]{}'.indexOf(c) !== -1)
			return null;
	}
	return null;
}

/* Emits the tail of a line after a complete value: blanks, comment, or stray text. */
function scanTrailing(line, pos, out) {
	const p = skipBlanks(line, pos);
	emitWhitespace(out, line.slice(pos, p));
	if (p >= line.length)
		return;
	if (line[p] === '#')
		emit(out, 'y-cmt', line.slice(p));
	else
		emit(out, 'y-bad', line.slice(p));
}

function scanProperties(line, pos, out) {
	while (pos < line.length && (line[pos] === '&' || line[pos] === '!')) {
		let end = pos;
		while (end < line.length && !isBlank(line[end]) && (line[end] !== ',' && line[end] !== ']' && line[end] !== '}' || end === pos))
			end++;
		emit(out, line[pos] === '&' ? 'y-anchor' : 'y-tag', line.slice(pos, end));
		pos = skipBlanks(line, end);
		emitWhitespace(out, line.slice(end, pos));
	}
	return pos;
}

/* Scans flow-collection content until the collection closes or the line ends. */
function scanFlow(line, pos, state, out) {
	const n = line.length;
	while (pos < n) {
		const ch = line[pos];
		if (isBlank(ch)) {
			const p = skipBlanks(line, pos);
			emitWhitespace(out, line.slice(pos, p));
			pos = p;
			continue;
		}
		if (commentAt(line, pos)) {
			emit(out, 'y-cmt', line.slice(pos));
			return n;
		}
		if (ch === '[' || ch === '{') {
			state.flow++;
			emit(out, 'y-punct', ch);
			pos++;
			continue;
		}
		if (ch === ']' || ch === '}') {
			state.flow = Math.max(0, state.flow - 1);
			emit(out, 'y-punct', ch);
			pos++;
			if (state.flow === 0)
				return pos;
			continue;
		}
		if (ch === ',') {
			emit(out, 'y-punct', ch);
			pos++;
			continue;
		}
		const key = matchKey(line, pos, true);
		if (key) {
			emit(out, 'y-key', line.slice(pos, key.keyEnd));
			emitWhitespace(out, line.slice(key.keyEnd, key.colon));
			emit(out, 'y-punct', ':');
			pos = key.colon + 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const end = ch === '"' ? scanDoubleQuoted(line, pos + 1) : scanSingleQuoted(line, pos + 1);
			if (end < 0) {
				state.quote = ch;
				emit(out, 'y-str', line.slice(pos));
				return n;
			}
			emit(out, 'y-str', line.slice(pos, end));
			pos = end;
			continue;
		}
		if (ch === '&' || ch === '!') {
			pos = scanProperties(line, pos, out);
			continue;
		}
		let end = pos;
		while (end < n && ',[]{}'.indexOf(line[end]) === -1 && !(line[end] === '#' && isBlank(line[end - 1])))
			end++;
		let textEnd = end;
		while (textEnd > pos && isBlank(line[textEnd - 1]))
			textEnd--;
		const text = line.slice(pos, textEnd);
		emit(out, ch === '*' ? 'y-alias' : scalarClass(text), text);
		emitWhitespace(out, line.slice(textEnd, end));
		pos = end;
	}
	return pos;
}

/*
 * Scans a block-context value starting at pos (just after "key:" or "- ").
 * ownerColumn is the column of the owning key or sequence dash; it decides
 * which following lines belong to a block scalar.
 */
function scanBlockValue(line, pos, state, out, info, ownerColumn) {
	const n = line.length;
	let p = skipBlanks(line, pos);
	emitWhitespace(out, line.slice(pos, p));
	if (p >= n) {
		info.open = true;
		return;
	}
	if (line[p] === '#') {
		emit(out, 'y-cmt', line.slice(p));
		info.open = true;
		return;
	}
	if (line[p] === '&' || line[p] === '!') {
		p = scanProperties(line, p, out);
		if (p >= n || line[p] === '#') {
			info.open = true;
			info.value = 'props';
			if (p < n)
				emit(out, 'y-cmt', line.slice(p));
			return;
		}
	}
	const ch = line[p];
	if (ch === '*') {
		let end = p;
		while (end < n && !isBlank(line[end]))
			end++;
		emit(out, 'y-alias', line.slice(p, end));
		info.value = 'scalar';
		scanTrailing(line, end, out);
		return;
	}
	if (ch === '|' || ch === '>') {
		let end = p;
		while (end < n && !isBlank(line[end]))
			end++;
		const indicator = line.slice(p, end);
		if (BLOCK_INDICATOR.test(indicator)) {
			emit(out, 'y-block', indicator);
			state.block = ownerColumn;
			info.value = 'block';
			scanTrailing(line, end, out);
			return;
		}
	}
	if (ch === '"' || ch === "'") {
		const end = ch === '"' ? scanDoubleQuoted(line, p + 1) : scanSingleQuoted(line, p + 1);
		if (end < 0) {
			state.quote = ch;
			info.value = 'quote';
			emit(out, 'y-str', line.slice(p));
			return;
		}
		emit(out, 'y-str', line.slice(p, end));
		info.value = 'scalar';
		scanTrailing(line, end, out);
		return;
	}
	if (ch === '[' || ch === '{') {
		info.value = 'flow';
		const end = scanFlow(line, p, state, out);
		if (state.flow === 0 && !state.quote)
			scanTrailing(line, end, out);
		return;
	}
	let end = p;
	while (end < n && !(line[end] === '#' && isBlank(line[end - 1])))
		end++;
	let textEnd = end;
	while (textEnd > p && isBlank(line[textEnd - 1]))
		textEnd--;
	const text = line.slice(p, textEnd);
	const nested = text.search(/:(?:[ \t]|$)/);
	if (nested !== -1) {
		emit(out, scalarClass(text.slice(0, nested)), text.slice(0, nested));
		emit(out, 'y-bad', text.slice(nested));
		info.problems.push(_("Nested 'key: value' inside a plain value is not allowed; quote the value or move it to its own line."));
	} else {
		emit(out, scalarClass(text), text);
	}
	info.value = 'scalar';
	emitWhitespace(out, line.slice(textEnd, end));
	if (end < n)
		emit(out, 'y-cmt', line.slice(end));
}

/*
 * Tokenizes one line. Returns { html, state, info } where state is the
 * scanner state for the next line and info describes the line's structure
 * for indentation and lint logic.
 */
function scanLine(line, inputState) {
	const state = { block: inputState.block, quote: inputState.quote, flow: inputState.flow };
	const out = [];
	const info = { kind: 'blank', indent: 0, tab: false, markers: [], key: null, keyColumn: -1, open: false, value: 'none', problems: [] };
	const n = line.length;
	let pos = skipBlanks(line, 0);
	const lead = line.slice(0, pos);
	info.indent = pos;
	info.tab = lead.indexOf('\t') !== -1;

	if (state.block >= 0) {
		const marker = pos === 0 && (line.indexOf('---') === 0 || line.indexOf('...') === 0) && (n === 3 || isBlank(line[3]));
		if (!marker && (pos >= n || pos > state.block)) {
			emitWhitespace(out, lead);
			emit(out, 'y-str', line.slice(pos));
			info.kind = 'blockcont';
			return { html: out.join(''), state: state, info: info };
		}
		state.block = -1;
	}

	if (state.quote) {
		const end = state.quote === '"' ? scanDoubleQuoted(line, 0) : scanSingleQuoted(line, 0);
		info.kind = 'cont';
		if (end < 0) {
			emit(out, 'y-str', line);
			return { html: out.join(''), state: state, info: info };
		}
		emit(out, 'y-str', line.slice(0, end));
		state.quote = '';
		let p = end;
		if (state.flow > 0)
			p = scanFlow(line, p, state, out);
		if (state.flow === 0 && !state.quote)
			scanTrailing(line, p, out);
		return { html: out.join(''), state: state, info: info };
	}

	if (state.flow > 0) {
		emitWhitespace(out, lead);
		info.kind = 'cont';
		const p = scanFlow(line, pos, state, out);
		if (state.flow === 0 && !state.quote)
			scanTrailing(line, p, out);
		return { html: out.join(''), state: state, info: info };
	}

	emitWhitespace(out, lead);
	if (pos >= n)
		return { html: out.join(''), state: state, info: info };

	if (line[pos] === '#') {
		emit(out, 'y-cmt', line.slice(pos));
		info.kind = 'comment';
		return { html: out.join(''), state: state, info: info };
	}

	if (pos === 0) {
		if ((line.indexOf('---') === 0 || line.indexOf('...') === 0) && (n === 3 || isBlank(line[3]))) {
			emit(out, 'y-doc', line.slice(0, 3));
			info.kind = 'doc';
			scanBlockValue(line, 3, state, out, info, -1);
			return { html: out.join(''), state: state, info: info };
		}
		if (line[0] === '%') {
			emit(out, 'y-dir', line);
			info.kind = 'directive';
			return { html: out.join(''), state: state, info: info };
		}
	}

	let p = pos;
	while (p < n && line[p] === '-' && (p + 1 >= n || isBlank(line[p + 1]))) {
		info.markers.push(p);
		emit(out, 'y-punct', '-');
		const next = skipBlanks(line, p + 1);
		emitWhitespace(out, line.slice(p + 1, next));
		p = next;
	}
	if (info.markers.length)
		info.kind = 'seq';
	const lastMarker = info.markers.length ? info.markers[info.markers.length - 1] : -1;

	if (p >= n) {
		info.open = true;
		return { html: out.join(''), state: state, info: info };
	}
	if (line[p] === '#') {
		emit(out, 'y-cmt', line.slice(p));
		info.open = true;
		return { html: out.join(''), state: state, info: info };
	}

	const key = matchKey(line, p, false);
	if (key) {
		if (!info.markers.length)
			info.kind = 'key';
		info.key = unquoteKey(line.slice(p, key.keyEnd));
		info.keyColumn = p;
		emit(out, 'y-key', line.slice(p, key.keyEnd));
		emitWhitespace(out, line.slice(key.keyEnd, key.colon));
		emit(out, 'y-punct', ':');
		scanBlockValue(line, key.colon + 1, state, out, info, p);
		return { html: out.join(''), state: state, info: info };
	}

	if ((line[p] === '?' || line[p] === ':') && (p + 1 >= n || isBlank(line[p + 1]))) {
		emit(out, 'y-punct', line[p]);
		info.kind = 'other';
		scanBlockValue(line, p + 1, state, out, info, p);
		return { html: out.join(''), state: state, info: info };
	}

	if (!info.markers.length)
		info.kind = 'scalar';
	scanBlockValue(line, p, state, out, info, lastMarker >= 0 ? lastMarker : pos);
	return { html: out.join(''), state: state, info: info };
}

/* Structural checks across lines; returns [{ line, message }]. */
function lintDocument(infos, finalState) {
	const problems = [];
	let stack = [];
	let lastKeyLine = -1;
	let lastFlowLine = -1;

	function push(indent, kind, compact) {
		const frame = { indent: indent, kind: kind, keys: {}, open: false, compact: !!compact };
		stack.push(frame);
		return frame;
	}

	function applyKey(frame, info, line) {
		if (info.key !== '<<' && Object.prototype.hasOwnProperty.call(frame.keys, info.key))
			problems.push({ line: line, message: _("Duplicate key '%s' in the same mapping.").format(info.key) });
		frame.keys[info.key] = true;
		frame.open = info.open;
	}

	for (let i = 0; i < infos.length && problems.length < PROBLEM_LIMIT; i++) {
		const info = infos[i];
		for (let j = 0; j < info.problems.length; j++)
			problems.push({ line: i, message: info.problems[j] });
		if (info.value === 'quote')
			lastKeyLine = i;
		if (info.value === 'flow')
			lastFlowLine = i;

		if (info.kind === 'blank' || info.kind === 'comment' || info.kind === 'blockcont' || info.kind === 'cont' || info.kind === 'directive' || info.kind === 'other')
			continue;
		if (info.kind === 'doc') {
			stack = [];
			continue;
		}
		if (info.tab) {
			problems.push({ line: i, message: _('Tab characters are not allowed in YAML indentation; use spaces.') });
			continue;
		}

		const indent = info.indent;
		let popped = false;
		while (stack.length && stack[stack.length - 1].indent > indent) {
			stack.pop();
			popped = true;
		}
		let top = stack.length ? stack[stack.length - 1] : null;
		let frame = null;

		if (!top) {
			if (info.kind === 'scalar')
				continue;
			frame = push(indent, info.kind === 'seq' ? 'seq' : 'map');
		} else if (top.indent < indent) {
			if (popped) {
				problems.push({ line: i, message: _('Inconsistent indentation: this line does not align with any enclosing level.') });
				if (info.kind === 'scalar')
					continue;
				frame = push(indent, info.kind === 'seq' ? 'seq' : 'map');
			} else if (info.kind === 'scalar') {
				top.open = false;
				continue;
			} else if (!top.open) {
				problems.push({ line: i, message: _('Unexpected indentation: the entry above already has a value on the same line.') });
				frame = push(indent, info.kind === 'seq' ? 'seq' : 'map');
			} else {
				top.open = false;
				frame = push(indent, info.kind === 'seq' ? 'seq' : 'map');
			}
		} else {
			if (info.kind === 'seq') {
				if (top.kind === 'map') {
					if (!top.open)
						problems.push({ line: i, message: _('A sequence entry (-) is not allowed here; the entry above already has a value.') });
					top.open = false;
					frame = push(indent, 'seq', true);
				} else {
					frame = top;
				}
			} else if (info.kind === 'key') {
				if (top.kind === 'seq') {
					if (top.compact) {
						stack.pop();
						frame = stack.length ? stack[stack.length - 1] : push(indent, 'map');
					} else {
						problems.push({ line: i, message: _('Expected a sequence entry (-) at this indentation.') });
						stack.pop();
						frame = push(indent, 'map');
					}
				} else {
					frame = top;
				}
			} else {
				problems.push({ line: i, message: _("Expected a 'key: value' pair or a sequence entry here.") });
				continue;
			}
		}

		if (info.kind === 'seq') {
			for (let m = 1; m < info.markers.length; m++)
				frame = push(info.markers[m], 'seq');
			if (info.key !== null) {
				frame.open = false;
				applyKey(push(info.keyColumn, 'map'), info, i);
			} else {
				frame.open = info.open;
			}
		} else {
			applyKey(frame, info, i);
		}
	}

	if (finalState.quote && lastKeyLine >= 0)
		problems.push({ line: lastKeyLine, message: _('Unterminated quoted string.') });
	if (finalState.flow > 0 && lastFlowLine >= 0)
		problems.push({ line: lastFlowLine, message: _('Unclosed flow collection: a [ or { is never closed.') });
	return problems;
}

/*
 * Computes the indentation for a line inserted after the given line text.
 * stateBefore is the scanner state at the start of that line, so that lines
 * inside block scalars, quoted strings and flow collections are recognised.
 */
function indentAfter(lineText, stateBefore) {
	const entering = stateBefore || INITIAL_STATE;
	const scan = scanLine(lineText, entering);
	const info = scan.info;
	const lead = lineText.slice(0, info.indent);
	if (info.kind === 'blank')
		return lead;
	const base = info.indent;
	if (scan.state.flow > entering.flow)
		return spaces(base + INDENT);
	if (info.kind === 'comment' || info.kind === 'cont' || info.kind === 'blockcont' || info.kind === 'directive')
		return lead;
	if (info.value === 'block')
		return spaces((info.key !== null ? info.keyColumn : info.markers.length ? info.markers[info.markers.length - 1] : base) + INDENT);
	if (info.key !== null)
		return spaces(info.open ? info.keyColumn + INDENT : info.keyColumn);
	if (info.markers.length)
		return spaces(info.open ? info.markers[info.markers.length - 1] + INDENT : base);
	if (info.kind === 'doc')
		return '';
	return lead;
}

function spaces(count) {
	return count > 0 ? new Array(count + 1).join(' ') : '';
}

function lineRange(value, start, end) {
	const from = value.lastIndexOf('\n', start - 1) + 1;
	let to = value.indexOf('\n', end);
	if (end > from && value[end - 1] === '\n' && end > start)
		to = end - 1;
	if (to === -1)
		to = value.length;
	return { from: from, to: to };
}

const Editor = L.Class.extend({
	__init__: function(options) {
		this.options = Object.assign({ value: '', readonly: false, height: 480, label: '', lint: true }, options || {});
		this.cache = new Map();
		this.problems = [];
		this.lineStarts = [ 0 ];
		this.lineCount = 1;
		this.gutterSignature = '';
		this.pending = false;
		this.highlighting = true;
		this.build();
		this.textarea.value = this.options.value || '';
		this.textarea.setSelectionRange(0, 0);
		this.render();
	},

	build: function() {
		const readonly = !!this.options.readonly;
		this.textarea = E('textarea', {
			'class': 'mihomo-code-input mihomo-code-text',
			'spellcheck': 'false',
			'autocomplete': 'off',
			'autocorrect': 'off',
			'autocapitalize': 'off',
			'wrap': 'off',
			'aria-label': this.options.label || 'YAML',
			'style': 'height:' + Number(this.options.height) + 'px'
		});
		if (readonly)
			this.textarea.setAttribute('readonly', 'readonly');
		this.code = E('code', { 'class': 'mihomo-code-text' });
		this.cursorLine = E('div', { 'class': 'mihomo-code-cursorline', 'aria-hidden': 'true' });
		this.gutterInner = E('div', { 'class': 'mihomo-code-gutter-inner' });
		this.gutter = E('div', { 'class': 'mihomo-code-gutter mihomo-code-text', 'aria-hidden': 'true' }, [ this.gutterInner ]);
		this.positionLabel = E('span', { 'class': 'mihomo-code-status-item' });
		this.selectionLabel = E('span', { 'class': 'mihomo-code-status-item mihomo-code-status-selection' });
		this.problemLabel = E('span', { 'class': 'mihomo-code-status-item mihomo-code-status-problems ok' });
		this.problemList = E('div', { 'class': 'mihomo-code-problems', 'style': 'display:none' });
		const statusRight = [
			E('span', { 'class': 'mihomo-code-status-item' }, [ _('Spaces: %d').format(INDENT) ]),
			E('span', { 'class': 'mihomo-code-status-item' }, [ 'YAML' ])
		];
		if (readonly)
			statusRight.unshift(E('span', { 'class': 'mihomo-code-status-item' }, [ _('Read-only') ]));
		this.root = E('div', { 'class': 'mihomo-code' + (readonly ? ' readonly' : '') }, [
			E('div', { 'class': 'mihomo-code-main' }, [
				this.gutter,
				E('div', { 'class': 'mihomo-code-body' }, [
					E('pre', { 'class': 'mihomo-code-highlight', 'aria-hidden': 'true' }, [ this.cursorLine, this.code ]),
					this.textarea
				])
			]),
			E('div', { 'class': 'mihomo-code-status' }, [
				E('div', { 'class': 'mihomo-code-status-left' }, [ this.positionLabel, this.selectionLabel, this.problemLabel ]),
				E('div', { 'class': 'mihomo-code-status-right' }, statusRight)
			]),
			this.problemList
		]);

		this.textarea.addEventListener('input', L.bind(this.schedule, this));
		this.textarea.addEventListener('scroll', L.bind(this.syncScroll, this), { passive: true });
		[ 'keyup', 'mouseup', 'focus', 'select', 'click' ].forEach(L.bind(function(name) {
			this.textarea.addEventListener(name, L.bind(this.updateCursor, this));
		}, this));
		document.addEventListener('selectionchange', L.bind(function() {
			if (document.activeElement === this.textarea)
				this.updateCursor();
		}, this));
		if (!readonly)
			this.textarea.addEventListener('keydown', L.bind(this.handleKey, this));
		this.problemLabel.addEventListener('click', L.bind(function() {
			if (this.problems.length)
				this.problemList.style.display = this.problemList.style.display === 'none' ? '' : 'none';
		}, this));
	},

	getValue: function() {
		return this.textarea.value;
	},

	setValue: function(value) {
		this.textarea.value = value == null ? '' : String(value);
		this.textarea.setSelectionRange(0, 0);
		this.textarea.scrollTop = 0;
		this.textarea.scrollLeft = 0;
		this.render();
	},

	focus: function() {
		this.textarea.focus();
	},

	schedule: function() {
		if (this.pending)
			return;
		this.pending = true;
		window.requestAnimationFrame(L.bind(function() {
			this.pending = false;
			this.render();
		}, this));
	},

	render: function() {
		const value = this.textarea.value;
		const lines = value.split('\n');
		const html = [];
		const infos = [];
		const starts = new Array(lines.length);
		const states = new Array(lines.length);
		let offset = 0;
		let state = INITIAL_STATE;
		this.highlighting = value.length <= HIGHLIGHT_LIMIT;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			starts[i] = offset;
			states[i] = state;
			offset += line.length + 1;
			if (!this.highlighting) {
				html.push(escapeHTML(line));
				continue;
			}
			const key = stateKey(state) + '\u0001' + line;
			let entry = this.cache.get(key);
			if (!entry) {
				if (this.cache.size >= CACHE_LIMIT)
					this.cache.clear();
				entry = scanLine(line, state);
				this.cache.set(key, entry);
			}
			html.push(entry.html);
			infos.push(entry.info);
			state = entry.state;
		}

		this.lineStarts = starts;
		this.lineStates = states;
		this.lineCount = lines.length;
		this.problems = (this.highlighting && this.options.lint && !this.options.readonly) ? lintDocument(infos, state) : [];
		const errorLines = {};
		this.problems.forEach(function(problem) { errorLines[problem.line] = true; });
		for (let i = 0; i < html.length; i++)
			if (errorLines[i])
				html[i] = '<span class="y-err">' + (html[i] || ' ') + '</span>';
		this.code.innerHTML = html.join('\n') + '\n';
		this.renderGutter(errorLines);
		this.renderProblems();
		this.syncScroll();
		this.updateCursor();
	},

	renderGutter: function(errorLines) {
		const signature = this.lineCount + '|' + Object.keys(errorLines).join(',');
		if (signature === this.gutterSignature)
			return;
		this.gutterSignature = signature;
		const parts = new Array(this.lineCount);
		for (let i = 0; i < this.lineCount; i++)
			parts[i] = errorLines[i] ? '<span class="err">' + (i + 1) + '</span>' : '<span>' + (i + 1) + '</span>';
		this.gutterInner.innerHTML = parts.join('');
		this.gutter.style.width = 'calc(' + Math.max(2, String(this.lineCount).length) + 'ch + 1.4rem)';
		this.activeGutterLine = null;
	},

	renderProblems: function() {
		const count = this.problems.length;
		if (!this.highlighting) {
			this.problemLabel.className = 'mihomo-code-status-item mihomo-code-status-problems';
			this.problemLabel.textContent = _('Highlighting disabled for large content');
			this.problemList.style.display = 'none';
			return;
		}
		if (this.options.readonly || !this.options.lint) {
			this.problemLabel.textContent = '';
			this.problemList.style.display = 'none';
			return;
		}
		this.problemLabel.className = 'mihomo-code-status-item mihomo-code-status-problems ' + (count ? 'bad' : 'ok');
		this.problemLabel.textContent = count ? N_('%d problem', '%d problems', count).format(count) : _('No problems');
		this.problemLabel.title = count ? _('Show or hide the problem list') : '';
		if (!count) {
			this.problemList.style.display = 'none';
			this.problemList.innerHTML = '';
			return;
		}
		const rows = this.problems.slice(0, 50).map(L.bind(function(problem) {
			const row = E('button', { 'type': 'button', 'class': 'mihomo-code-problem' }, [
				E('span', { 'class': 'mihomo-code-problem-line' }, [ _('Ln %d').format(problem.line + 1) ]),
				E('span', {}, [ problem.message ])
			]);
			row.addEventListener('click', L.bind(this.gotoLine, this, problem.line));
			return row;
		}, this));
		dom.content(this.problemList, rows);
		this.problemList.style.display = '';
	},

	gotoLine: function(line) {
		const start = this.lineStarts[Math.min(line, this.lineStarts.length - 1)] || 0;
		this.textarea.focus();
		this.textarea.setSelectionRange(start, start);
		const metrics = this.metrics();
		if (metrics)
			this.textarea.scrollTop = Math.max(0, line * metrics.lineHeight - this.textarea.clientHeight / 2);
		this.updateCursor();
	},

	/* Re-syncs overlay positions, e.g. after the editor becomes visible. */
	refresh: function() {
		this.syncScroll();
		this.updateCursor();
	},

	metrics: function() {
		if (!this.textarea.offsetParent)
			return null;
		const style = window.getComputedStyle(this.textarea);
		let lineHeight = parseFloat(style.lineHeight);
		if (!isFinite(lineHeight) || lineHeight <= 0)
			return null;
		if (lineHeight < 4)
			lineHeight *= parseFloat(style.fontSize) || 16;
		return { lineHeight: lineHeight, paddingTop: parseFloat(style.paddingTop) || 0 };
	},

	syncScroll: function() {
		const top = this.textarea.scrollTop;
		const left = this.textarea.scrollLeft;
		this.code.style.transform = 'translate(' + (-left) + 'px,' + (-top) + 'px)';
		this.gutterInner.style.transform = 'translateY(' + (-top) + 'px)';
		this.placeCursorLine();
	},

	lineAt: function(offset) {
		const starts = this.lineStarts;
		let low = 0, high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if (starts[mid] <= offset)
				low = mid;
			else
				high = mid - 1;
		}
		return low;
	},

	updateCursor: function() {
		const start = this.textarea.selectionStart;
		const end = this.textarea.selectionEnd;
		const line = this.lineAt(start);
		this.currentLine = line;
		this.positionLabel.textContent = _('Ln %d, Col %d').format(line + 1, start - this.lineStarts[line] + 1);
		this.selectionLabel.textContent = end > start ? _('(%d selected)').format(end - start) : '';
		if (this.activeGutterLine !== line) {
			if (this.activeGutterLine != null && this.gutterInner.children[this.activeGutterLine])
				this.gutterInner.children[this.activeGutterLine].classList.remove('active');
			if (this.gutterInner.children[line])
				this.gutterInner.children[line].classList.add('active');
			this.activeGutterLine = line;
		}
		this.placeCursorLine();
	},

	placeCursorLine: function() {
		const metrics = this.metrics();
		if (!metrics || this.currentLine == null) {
			this.cursorLine.style.display = 'none';
			return;
		}
		this.cursorLine.style.display = '';
		this.cursorLine.style.height = metrics.lineHeight + 'px';
		this.cursorLine.style.top = (metrics.paddingTop + this.currentLine * metrics.lineHeight - this.textarea.scrollTop) + 'px';
	},

	/*
	 * Replaces [start, end) with text. execCommand keeps the browser's native
	 * undo history intact; setRangeText is the fallback when it is unavailable.
	 */
	replaceRange: function(start, end, text, cursorStart, cursorEnd) {
		const field = this.textarea;
		const expected = field.value.slice(0, start) + text + field.value.slice(end);
		field.focus();
		field.setSelectionRange(start, end);
		let ok = false;
		try {
			ok = document.execCommand(text === '' ? 'delete' : 'insertText', false, text);
		}
		catch (ignored) {
			ok = false;
		}
		if (!ok) {
			field.setRangeText(text, start, end, 'end');
			if (field.value !== expected)
				field.value = expected;
			field.dispatchEvent(new Event('input', { bubbles: true }));
		}
		if (cursorStart === undefined)
			cursorStart = start + text.length;
		field.setSelectionRange(cursorStart, cursorEnd === undefined ? cursorStart : cursorEnd);
		this.updateCursor();
	},

	handleKey: function(event) {
		if (event.isComposing || event.altKey)
			return;
		if (event.metaKey && event.key !== '/')
			return;
		const field = this.textarea;
		const value = field.value;
		const start = field.selectionStart;
		const end = field.selectionEnd;
		const key = event.key;

		if (key === 'Tab' && !event.ctrlKey) {
			event.preventDefault();
			if (event.shiftKey || value.slice(start, end).indexOf('\n') !== -1)
				this.shiftLines(start, end, event.shiftKey ? -1 : 1);
			else {
				const column = start - (value.lastIndexOf('\n', start - 1) + 1);
				this.replaceRange(start, end, spaces(INDENT - (column % INDENT)));
			}
			return;
		}

		if (key === '/' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			this.toggleComment(start, end);
			return;
		}

		if (event.ctrlKey)
			return;

		if (key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			const lineStart = value.lastIndexOf('\n', start - 1) + 1;
			const lineEnd = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
			const before = value.slice(lineStart, start);
			const after = value.slice(end, lineEnd);
			const line = this.lineAt(start);
			const indent = indentAfter(before, this.lineStates && this.lineStates[line]);
			const opener = before.trim().slice(-1);
			const closer = after.trim()[0];
			if ((opener === '{' && closer === '}') || (opener === '[' && closer === ']')) {
				const outer = before.match(/^[ \t]*/)[0];
				this.replaceRange(start, end, '\n' + indent + '\n' + outer, start + 1 + indent.length);
				return;
			}
			this.replaceRange(start, end, '\n' + indent);
			return;
		}

		if (key === 'Backspace' && start === end && start > 0) {
			const lineStart = value.lastIndexOf('\n', start - 1) + 1;
			const before = value.slice(lineStart, start);
			const prev = value[start - 1];
			const next = value[start];
			if ((prev === '[' && next === ']') || (prev === '{' && next === '}') || ((prev === '"' || prev === "'") && next === prev)) {
				event.preventDefault();
				this.replaceRange(start - 1, start + 1, '');
				return;
			}
			if (before.length > 0 && /^ +$/.test(before)) {
				event.preventDefault();
				const remove = before.length % INDENT || INDENT;
				this.replaceRange(start - remove, start, '');
				return;
			}
			return;
		}

		if (key === 'Home' && !event.shiftKey && start === end) {
			const lineStart = value.lastIndexOf('\n', start - 1) + 1;
			const lineEnd = value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start);
			const first = lineStart + value.slice(lineStart, lineEnd).match(/^[ \t]*/)[0].length;
			event.preventDefault();
			const target = start === first ? lineStart : first;
			field.setSelectionRange(target, target);
			this.updateCursor();
			return;
		}

		if (key === '[' || key === '{' || key === '"' || key === "'") {
			const closer = key === '[' ? ']' : key === '{' ? '}' : key;
			const selected = value.slice(start, end);
			if (selected.length && selected.indexOf('\n') === -1) {
				event.preventDefault();
				this.replaceRange(start, end, key + selected + closer, start + 1, end + 1);
				return;
			}
			if (start !== end)
				return;
			const next = value[start];
			const prev = value[start - 1];
			if ((key === '"' || key === "'") && next === key) {
				event.preventDefault();
				field.setSelectionRange(start + 1, start + 1);
				this.updateCursor();
				return;
			}
			if ((key === '"' || key === "'") && prev !== undefined && (WORD_CHAR.test(prev) || prev === key))
				return;
			if (next === undefined || next === '\n' || isBlank(next) || ']},'.indexOf(next) !== -1) {
				event.preventDefault();
				this.replaceRange(start, end, key + closer, start + 1);
			}
			return;
		}

		if ((key === ']' || key === '}') && start === end && value[start] === key) {
			event.preventDefault();
			field.setSelectionRange(start + 1, start + 1);
			this.updateCursor();
		}
	},

	shiftLines: function(start, end, direction) {
		const value = this.textarea.value;
		const range = lineRange(value, start, end);
		const lines = value.slice(range.from, range.to).split('\n');
		let firstDelta = 0;
		let total = 0;
		const changed = lines.map(function(line, index) {
			let delta = 0;
			let next = line;
			if (direction > 0) {
				if (line.length || lines.length === 1) {
					next = spaces(INDENT) + line;
					delta = INDENT;
				}
			} else {
				const match = line.match(/^(?: {1,2}|\t)/);
				if (match) {
					next = line.slice(match[0].length);
					delta = -match[0].length;
				}
			}
			if (index === 0)
				firstDelta = delta;
			total += delta;
			return next;
		});
		if (!total)
			return;
		const text = changed.join('\n');
		const newStart = Math.max(range.from, start + firstDelta);
		const newEnd = start === end ? newStart : Math.max(newStart, end + total);
		this.replaceRange(range.from, range.to, text, newStart, newEnd);
	},

	toggleComment: function(start, end) {
		const value = this.textarea.value;
		const range = lineRange(value, start, end);
		const lines = value.slice(range.from, range.to).split('\n');
		let content = lines.filter(function(line) { return line.trim().length; });
		const blankOnly = !content.length;
		if (blankOnly)
			content = lines;
		const allCommented = !blankOnly && content.every(function(line) { return line.trim()[0] === '#'; });
		let column = Infinity;
		content.forEach(function(line) { column = Math.min(column, line.match(/^[ \t]*/)[0].length); });
		let firstDelta = 0;
		let total = 0;
		const changed = lines.map(function(line, index) {
			let delta = 0;
			let next = line;
			if (!blankOnly && !line.trim().length)
				return line;
			if (allCommented) {
				next = line.replace(/^([ \t]*)#[ ]?/, '$1');
				delta = next.length - line.length;
			} else {
				next = line.slice(0, column) + '# ' + line.slice(column);
				delta = 2;
			}
			if (index === 0)
				firstDelta = delta;
			total += delta;
			return next;
		});
		const text = changed.join('\n');
		const newStart = Math.max(range.from, start + firstDelta);
		const newEnd = start === end ? newStart : Math.max(newStart, end + total);
		this.replaceRange(range.from, range.to, text, newStart, newEnd);
	}
});

return L.Class.extend({
	create: function(options) {
		return new Editor(options);
	},

	scanLine: scanLine,
	lintDocument: lintDocument,
	indentAfter: indentAfter,
	INDENT: INDENT,

	/* Convenience for tests: tokenizes a whole document. */
	analyze: function(text) {
		const lines = String(text).split('\n');
		const infos = [];
		const html = [];
		let state = INITIAL_STATE;
		lines.forEach(function(line) {
			const entry = scanLine(line, state);
			infos.push(entry.info);
			html.push(entry.html);
			state = entry.state;
		});
		return { infos: infos, html: html, problems: lintDocument(infos, state), state: state };
	}
});
