'use strict';
'require view';
'require dom';
'require ui';
'require mihomo.api as api';
'require mihomo.common as common';

return view.extend({
	load: function() {
		common.ensureStyle();
		return api.write('config-get', {});
	},

	render: function(data) {
		this.data = data;
		this.dirty = false;
		const baseEditor = E('textarea', {
			'class': 'cbi-input-textarea mihomo-editor',
			'spellcheck': 'false',
			'aria-label': _('Base Mihomo configuration'),
			'data-editor': 'base',
			'input': L.bind(function() { this.dirty = true; this.updateDirtyState(); }, this),
			'keydown': this.handleTab
		}, [ data.base ]);
		const effectiveEditor = E('textarea', {
			'class': 'cbi-input-textarea mihomo-editor',
			'spellcheck': 'false',
			'readonly': 'readonly',
			'aria-label': _('Effective Mihomo configuration'),
			'data-editor': 'effective'
		}, [ data.effective ]);
		const basePane = E('div', { 'data-pane': 'base' }, [ baseEditor ]);
		const effectivePane = E('div', { 'data-pane': 'effective', 'style': 'display:none' }, [ effectiveEditor ]);
		const applyButton = E('button', {
			'class': 'cbi-button cbi-button-apply',
			'type': 'button',
			'data-action': 'apply',
			'click': L.bind(this.apply, this)
		}, [ _('Validate and apply') ]);

		this.root = E('div', { 'class': 'mihomo-page' }, [
			E('div', { 'class': 'mihomo-head' }, [
				E('div', {}, [ E('h2', {}, [ _('Mihomo configuration') ]), E('div', { 'class': 'mihomo-subtitle' }, [ _('Edit the source configuration; the effective file is generated with active overrides.') ]) ]),
				E('div', { 'class': 'mihomo-toolbar' }, [
					E('span', { 'class': 'mihomo-badge good', 'data-state': 'saved' }, [ _('Saved') ]),
					E('button', { 'class': 'cbi-button', 'type': 'button', 'click': L.bind(this.reload, this) }, [ _('Reload from disk') ]),
					applyButton
				])
			]),
			E('div', { 'class': 'alert-message warning' }, [
				E('strong', {}, [ _('Atomic apply: ') ]),
				_('the candidate is written to /tmp/mihomo-config.yaml.new, checked with mihomo -t, atomically moved into place, then reloaded. A failed health check restores the previous files.')
			]),
			E('section', { 'class': 'mihomo-card full', 'style': 'margin-top:.85rem' }, [
				E('div', { 'class': 'mihomo-tabs' }, [
					E('button', { 'class': 'cbi-button mihomo-tab active', 'type': 'button', 'data-tab': 'base', 'click': L.bind(this.selectTab, this, 'base') }, [ _('Source · config.base.yaml') ]),
					E('button', { 'class': 'cbi-button mihomo-tab', 'type': 'button', 'data-tab': 'effective', 'click': L.bind(this.selectTab, this, 'effective') }, [ _('Effective · config.yaml') ])
				]),
				basePane,
				effectivePane,
				E('div', { 'class': 'mihomo-muted', 'style': 'margin-top:.55rem' }, [
					E('span', {}, [ _('Source revision: ') ]), E('code', { 'data-revision': 'base' }, [ data.baseRevision.slice(0, 12) ]),
					E('span', { 'style': 'margin-left:1rem' }, [ _('Effective revision: ') ]), E('code', { 'data-revision': 'effective' }, [ data.effectiveRevision.slice(0, 12) ])
				])
			])
		]);
		return this.root;
	},

	handleTab: function(event) {
		if (event.key !== 'Tab')
			return;
		event.preventDefault();
		const field = event.currentTarget;
		const start = field.selectionStart;
		field.setRangeText('  ', start, field.selectionEnd, 'end');
		field.dispatchEvent(new Event('input', { bubbles: true }));
	},

	selectTab: function(name) {
		this.root.querySelectorAll('[data-pane]').forEach(function(pane) { pane.style.display = pane.getAttribute('data-pane') === name ? '' : 'none'; });
		this.root.querySelectorAll('[data-tab]').forEach(function(tab) { tab.classList.toggle('active', tab.getAttribute('data-tab') === name); });
	},

	updateDirtyState: function() {
		const badge = this.root.querySelector('[data-state="saved"]');
		badge.textContent = this.dirty ? _('Unsaved changes') : _('Saved');
		badge.className = 'mihomo-badge ' + (this.dirty ? 'warn' : 'good');
	},

	reload: function() {
		if (this.dirty && !window.confirm(_('Discard the unsaved configuration changes?')))
			return;
		return api.write('config-get', {}).then(L.bind(function(data) {
			this.data = data;
			this.root.querySelector('[data-editor="base"]').value = data.base;
			this.root.querySelector('[data-editor="effective"]').value = data.effective;
			this.root.querySelector('[data-revision="base"]').textContent = data.baseRevision.slice(0, 12);
			this.root.querySelector('[data-revision="effective"]').textContent = data.effectiveRevision.slice(0, 12);
			this.dirty = false;
			this.updateDirtyState();
		}, this)).catch(common.notifyError);
	},

	apply: function(event) {
		const content = this.root.querySelector('[data-editor="base"]').value;
		if (!window.confirm(_('Validate this source configuration and replace the effective Mihomo configuration?')))
			return;
		const button = event.currentTarget;
		common.setBusy(button, true);
		api.write('config-apply', { content: content, revision: this.data.baseRevision }).then(L.bind(function(result) {
			const serviceState = result.serviceWasRunning ? _('Mihomo was reloaded and passed its health check.') : _('Mihomo was stopped and remains stopped.');
			common.notifySuccess(_('Configuration applied. ') + serviceState);
			this.dirty = false;
			return this.reload();
		}, this)).catch(common.notifyError).finally(function() { common.setBusy(button, false); });
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
