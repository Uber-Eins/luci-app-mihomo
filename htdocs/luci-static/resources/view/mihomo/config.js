'use strict';
'require view';
'require dom';
'require ui';
'require mihomo.api as api';
'require mihomo.common as common';
'require mihomo.editor as editor';

return view.extend({
	load: function() {
		common.ensureStyle();
		return api.write('config-get', {});
	},

	render: function(data) {
		this.data = data;
		this.dirty = false;
		this.baseEditor = editor.create({
			value: data.base,
			label: _('Base Mihomo configuration'),
			height: 520
		});
		this.baseEditor.textarea.addEventListener('input', L.bind(function() { this.dirty = true; this.updateDirtyState(); }, this));
		this.effectiveEditor = editor.create({
			value: data.effective,
			readonly: true,
			label: _('Effective Mihomo configuration'),
			height: 520
		});
		const basePane = E('div', { 'data-pane': 'base' }, [ this.baseEditor.root ]);
		const effectivePane = E('div', { 'data-pane': 'effective', 'style': 'display:none' }, [ this.effectiveEditor.root ]);
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
				common.editorHint(),
				E('div', { 'class': 'mihomo-muted', 'style': 'margin-top:.55rem' }, [
					E('span', {}, [ _('Source revision: ') ]), E('code', { 'data-revision': 'base' }, [ data.baseRevision.slice(0, 12) ]),
					E('span', { 'style': 'margin-left:1rem' }, [ _('Effective revision: ') ]), E('code', { 'data-revision': 'effective' }, [ data.effectiveRevision.slice(0, 12) ])
				])
			])
		]);
		return this.root;
	},

	selectTab: function(name) {
		this.root.querySelectorAll('[data-pane]').forEach(function(pane) { pane.style.display = pane.getAttribute('data-pane') === name ? '' : 'none'; });
		this.root.querySelectorAll('[data-tab]').forEach(function(tab) { tab.classList.toggle('active', tab.getAttribute('data-tab') === name); });
		(name === 'base' ? this.baseEditor : this.effectiveEditor).refresh();
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
			this.baseEditor.setValue(data.base);
			this.effectiveEditor.setValue(data.effective);
			this.root.querySelector('[data-revision="base"]').textContent = data.baseRevision.slice(0, 12);
			this.root.querySelector('[data-revision="effective"]').textContent = data.effectiveRevision.slice(0, 12);
			this.dirty = false;
			this.updateDirtyState();
		}, this)).catch(common.notifyError);
	},

	apply: function(event) {
		const content = this.baseEditor.getValue();
		const problems = this.baseEditor.problems.length;
		const question = problems
			? N_('The editor reports %d YAML problem. Validate this source configuration anyway and replace the effective Mihomo configuration?',
				'The editor reports %d YAML problems. Validate this source configuration anyway and replace the effective Mihomo configuration?', problems).format(problems)
			: _('Validate this source configuration and replace the effective Mihomo configuration?');
		if (!window.confirm(question))
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
