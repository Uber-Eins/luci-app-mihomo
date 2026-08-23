'use strict';
'require view';
'require dom';
'require poll';
'require mihomo.api as api';
'require mihomo.common as common';

return view.extend({
	load: function() {
		common.ensureStyle();
		this.cursor = 0;
		this.entries = [];
		this.paused = false;
		this.autoscroll = true;
		this.level = 'all';
		this.search = '';
		return api.read('logs', { cursor: 0, limit: 500 });
	},

	render: function(data) {
		this.cursor = data.cursor || 0;
		this.entries = data.entries || [];
		const level = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Log level') }, [
			E('option', { value: 'all' }, [ _('All levels') ]),
			E('option', { value: 'debug' }, [ _('Debug') ]),
			E('option', { value: 'info' }, [ _('Info') ]),
			E('option', { value: 'warning' }, [ _('Warning') ]),
			E('option', { value: 'error' }, [ _('Error') ])
		]);
		level.addEventListener('change', L.bind(function(event) { this.level = event.target.value; this.resetQuery(); }, this));
		const search = E('input', { 'class': 'cbi-input-text', 'type': 'search', 'placeholder': _('Search messages'), 'aria-label': _('Search messages') });
		let searchTimer;
		search.addEventListener('input', L.bind(function(event) {
			window.clearTimeout(searchTimer);
			searchTimer = window.setTimeout(L.bind(function() { this.search = event.target.value; this.resetQuery(); }, this), 300);
		}, this));
		const pause = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'data-action': 'pause', 'click': L.bind(this.togglePause, this) }, [ _('Pause') ]);
		const autoscroll = E('input', { 'type': 'checkbox', 'checked': 'checked', 'id': 'mihomo-log-autoscroll' });
		autoscroll.checked = true;
		autoscroll.addEventListener('change', L.bind(function(event) { this.autoscroll = event.target.checked; }, this));

		this.root = E('div', { 'class': 'mihomo-page' }, [
			E('div', { 'class': 'mihomo-head' }, [
				E('div', {}, [ E('h2', {}, [ _('Mihomo logs') ]), E('div', { 'class': 'mihomo-subtitle' }, [ _('Live logs arrive over the local Unix controller and are kept only in a bounded memory buffer.') ]) ]),
				E('div', { 'class': 'mihomo-toolbar' }, [
					level, search, pause,
					E('label', { 'class': 'mihomo-inline', 'for': 'mihomo-log-autoscroll' }, [ autoscroll, _('Auto-scroll') ]),
					E('button', { 'class': 'cbi-button', 'type': 'button', 'click': L.bind(this.clearLocal, this) }, [ _('Clear view') ])
				])
			]),
			E('div', { 'class': 'mihomo-inline mihomo-muted' }, [ E('span', { 'data-log': 'count' }), E('span', {}, [ '·' ]), E('span', { 'data-log': 'cursor' }) ]),
			E('div', { 'class': 'mihomo-log-view', 'data-log': 'view', 'role': 'log', 'aria-live': 'off' })
		]);
		this.renderEntries();
		poll.add(L.bind(this.pollLogs, this), 2);
		return this.root;
	},

	pollLogs: function() {
		if (this.paused)
			return Promise.resolve();
		return api.read('logs', { cursor: this.cursor, limit: 500, level: this.level, q: this.search }).then(L.bind(function(data) {
			this.cursor = data.cursor || this.cursor;
			if (data.entries && data.entries.length) {
				this.entries = this.entries.concat(data.entries).slice(-2000);
				this.renderEntries();
			} else {
				this.updateMeta();
			}
		}, this)).catch(function() {
			// A stopped Mihomo instance is normal; retain the last visible log lines.
		});
	},

	renderEntries: function() {
		const view = this.root.querySelector('[data-log="view"]');
		const nodes = this.entries.map(function(entry) {
			const time = new Date(entry.time).toLocaleTimeString();
			return E('span', { 'class': 'mihomo-log-line ' + (entry.level || 'info') }, [ time + ' [' + String(entry.level || 'info').toUpperCase() + '] ' + entry.message + '\n' ]);
		});
		dom.content(view, nodes.length ? nodes : E('span', { 'class': 'mihomo-muted' }, [ _('No matching log entries.') ]));
		this.updateMeta();
		if (this.autoscroll)
			view.scrollTop = view.scrollHeight;
	},

	updateMeta: function() {
		this.root.querySelector('[data-log="count"]').textContent = N_('%d visible entry', '%d visible entries', this.entries.length).format(this.entries.length);
		this.root.querySelector('[data-log="cursor"]').textContent = _('Cursor %s').format(this.cursor);
	},

	togglePause: function() {
		this.paused = !this.paused;
		const button = this.root.querySelector('[data-action="pause"]');
		button.textContent = this.paused ? _('Resume') : _('Pause');
		button.classList.toggle('cbi-button-positive', this.paused);
		if (!this.paused)
			this.pollLogs();
	},

	clearLocal: function() {
		this.entries = [];
		this.renderEntries();
	},

	resetQuery: function() {
		this.cursor = 0;
		this.entries = [];
		this.renderEntries();
		if (!this.paused)
			this.pollLogs();
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

