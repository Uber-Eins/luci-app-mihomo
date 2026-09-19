'use strict';
'require view';
'require dom';
'require ui';
'require mihomo.api as api';
'require mihomo.common as common';
'require mihomo.editor as editor';

function newID() {
	if (window.crypto && window.crypto.getRandomValues) {
		const bytes = new Uint8Array(8);
		window.crypto.getRandomValues(bytes);
		return Array.from(bytes).map(function(value) { return value.toString(16).padStart(2, '0'); }).join('');
	}
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

return view.extend({
	load: function() {
		common.ensureStyle();
		return api.write('overrides-get', {});
	},

	render: function(data) {
		this.state = data;
		this.items = (data.draft || []).map(function(item) { return Object.assign({}, item); });
		this.dirty = false;
		this.previewDigest = null;
		this.previewDraftRevision = null;
		this.previewEditor = editor.create({ value: '', readonly: true, label: _('Effective configuration preview'), height: 400 });

		this.root = E('div', { 'class': 'mihomo-page' }, [
			E('div', { 'class': 'mihomo-head' }, [
				E('div', {}, [ E('h2', {}, [ _('YAML overrides') ]), E('div', { 'class': 'mihomo-subtitle' }, [ _('Enabled overrides are merged from top to bottom. Later items see and can replace earlier results.') ]) ]),
				E('div', { 'class': 'mihomo-toolbar' }, [
					E('span', { 'class': 'mihomo-badge', 'data-state': 'draft' }),
					E('button', { 'class': 'cbi-button', 'type': 'button', 'click': L.bind(this.reload, this) }, [ _('Reload') ]),
					E('button', { 'class': 'cbi-button cbi-button-positive', 'type': 'button', 'click': L.bind(this.addItem, this) }, [ _('Add override') ]),
					E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'data-action': 'save', 'click': L.bind(this.saveDraft, this, true) }, [ _('Save draft') ]),
					E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'data-action': 'preview', 'click': L.bind(this.preview, this) }, [ _('Preview') ]),
					E('button', { 'class': 'cbi-button cbi-button-apply', 'type': 'button', 'data-action': 'apply', 'disabled': true, 'click': L.bind(this.apply, this) }, [ _('Apply preview') ])
				])
			]),
			E('div', { 'class': 'alert-message notice' }, [
				E('strong', {}, [ _('Merge syntax: ') ]),
				_('maps merge recursively; ordinary arrays and scalar values replace. Use key! to force replacement, +key to prepend an array, key+ to append, and <key> to escape operator characters.')
			]),
			E('div', { 'class': 'mihomo-preview-status', 'data-preview': 'status' }, [ _('Save the draft, then generate a preview before applying.') ]),
			E('div', { 'data-overrides': 'list', 'style': 'margin-top:.85rem' }),
			common.editorHint(),
			E('section', { 'class': 'mihomo-card full', 'data-preview': 'panel', 'style': 'display:none' }, [
				E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Effective configuration preview') ]), E('code', { 'data-preview': 'digest' }) ]),
				this.previewEditor.root
			])
		]);
		this.renderItems();
		this.updateState();
		return this.root;
	},

	renderItems: function() {
		const container = this.root.querySelector('[data-overrides="list"]');
		if (!this.items.length) {
			dom.content(container, E('div', { 'class': 'mihomo-card full mihomo-empty' }, [ _('No overrides. Add one to begin.') ]));
			return;
		}
		const cards = this.items.map(L.bind(function(item, index) {
			const enabled = E('input', { 'type': 'checkbox', 'checked': item.enabled ? 'checked' : null, 'aria-label': _('Enable override') });
			enabled.checked = !!item.enabled;
			enabled.addEventListener('change', L.bind(function(event) { item.enabled = event.target.checked; this.changed(); this.renderItems(); }, this));
			const name = E('input', { 'class': 'cbi-input-text mihomo-override-name', 'type': 'text', 'value': item.name, 'placeholder': _('Override name'), 'aria-label': _('Override name') });
			name.value = item.name;
			name.addEventListener('input', L.bind(function(event) { item.name = event.target.value; this.changed(); }, this));
			const content = editor.create({ value: item.content, label: _('Override YAML'), height: 220 });
			content.textarea.addEventListener('input', L.bind(function(event) { item.content = event.target.value; this.changed(); }, this));
			return E('article', { 'class': 'mihomo-override' + (item.enabled ? '' : ' disabled') }, [
				E('div', { 'class': 'mihomo-override-actions' }, [
					E('span', { 'class': 'mihomo-override-index' }, [ String(index + 1) ]),
					enabled,
					name,
					E('button', { 'class': 'cbi-button', 'type': 'button', 'disabled': index === 0, 'title': _('Move up'), 'click': L.bind(this.moveItem, this, index, -1) }, [ '↑' ]),
					E('button', { 'class': 'cbi-button', 'type': 'button', 'disabled': index === this.items.length - 1, 'title': _('Move down'), 'click': L.bind(this.moveItem, this, index, 1) }, [ '↓' ]),
					E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'title': _('Delete'), 'click': L.bind(this.deleteItem, this, index) }, [ _('Delete') ])
				]),
				content.root
			]);
		}, this));
		dom.content(container, cards);
	},

	changed: function() {
		this.dirty = true;
		this.previewDigest = null;
		this.previewDraftRevision = null;
		const panel = this.root.querySelector('[data-preview="panel"]');
		if (panel) panel.style.display = 'none';
		this.updateState();
	},

	addItem: function() {
		this.items.push({ id: newID(), name: _('New override'), enabled: true, content: '# YAML override\n' });
		this.changed();
		this.renderItems();
	},

	moveItem: function(index, offset) {
		const target = index + offset;
		if (target < 0 || target >= this.items.length) return;
		const item = this.items.splice(index, 1)[0];
		this.items.splice(target, 0, item);
		this.changed();
		this.renderItems();
	},

	deleteItem: function(index) {
		if (!window.confirm(_('Delete this override from the draft?'))) return;
		this.items.splice(index, 1);
		this.changed();
		this.renderItems();
	},

	updateState: function() {
		const badge = this.root.querySelector('[data-state="draft"]');
		const apply = this.root.querySelector('[data-action="apply"]');
		if (this.dirty) {
			badge.className = 'mihomo-badge warn';
			badge.textContent = _('Draft has unsaved changes');
		} else if (this.state.changed) {
			badge.className = 'mihomo-badge warn';
			badge.textContent = _('Draft differs from active');
		} else {
			badge.className = 'mihomo-badge good';
			badge.textContent = _('Draft is active');
		}
		apply.disabled = !this.previewDigest;
		const status = this.root.querySelector('[data-preview="status"]');
		if (!this.previewDigest) {
			status.className = 'mihomo-preview-status';
			status.textContent = this.dirty ? _('Save and preview the changed draft before applying.') : _('Generate a preview before applying this draft.');
		}
	},

	saveDraft: function(notify, event) {
		const button = event && event.currentTarget;
		common.setBusy(button, true);
		return api.write('overrides-draft', { items: this.items, revision: this.state.draftRevision }).then(L.bind(function(data) {
			this.state = data;
			this.items = (data.draft || []).map(function(item) { return Object.assign({}, item); });
			this.dirty = false;
			this.renderItems();
			this.updateState();
			if (notify) common.notifySuccess(_('Override draft saved. Active configuration was not changed.'));
			return data;
		}, this)).catch(function(error) {
			common.notifyError(error);
			error.__notified = true;
			throw error;
		}).finally(function() { common.setBusy(button, false); });
	},

	preview: function(event) {
		const button = event.currentTarget;
		common.setBusy(button, true);
		const saved = this.dirty ? this.saveDraft(false) : Promise.resolve(this.state);
		saved.then(L.bind(function() {
			return api.write('overrides-preview', { revision: this.state.draftRevision });
		}, this)).then(L.bind(function(preview) {
			this.previewDigest = preview.digest;
			this.previewDraftRevision = preview.draftRevision;
			this.root.querySelector('[data-preview="digest"]').textContent = preview.digest.slice(0, 16);
			this.root.querySelector('[data-preview="panel"]').style.display = '';
			this.previewEditor.setValue(preview.yaml);
			this.previewEditor.refresh();
			const status = this.root.querySelector('[data-preview="status"]');
			status.className = 'mihomo-preview-status ready';
			status.textContent = _('Preview is current. Review it, then explicitly apply it.');
			this.updateState();
		}, this)).catch(function(error) {
			if (!error.__notified) common.notifyError(error);
		}).finally(function() { common.setBusy(button, false); });
	},

	apply: function(event) {
		if (!this.previewDigest || !window.confirm(_('Validate and activate exactly the configuration shown in the current preview?')))
			return;
		const button = event.currentTarget;
		common.setBusy(button, true);
		api.write('overrides-apply', { revision: this.previewDraftRevision, digest: this.previewDigest }).then(L.bind(function(result) {
			common.notifySuccess(result.serviceWasRunning ? _('Overrides applied and Mihomo reloaded successfully.') : _('Overrides applied. Mihomo was stopped and remains stopped.'));
			return api.write('overrides-get', {});
		}, this)).then(L.bind(function(data) {
			this.state = data;
			this.items = (data.draft || []).map(function(item) { return Object.assign({}, item); });
			this.dirty = false;
			this.previewDigest = null;
			this.previewDraftRevision = null;
			this.root.querySelector('[data-preview="panel"]').style.display = 'none';
			this.renderItems();
			this.updateState();
		}, this)).catch(common.notifyError).finally(function() { common.setBusy(button, false); });
	},

	reload: function() {
		if (this.dirty && !window.confirm(_('Discard unsaved override draft changes?'))) return;
		return api.write('overrides-get', {}).then(L.bind(function(data) {
			this.state = data;
			this.items = (data.draft || []).map(function(item) { return Object.assign({}, item); });
			this.dirty = false;
			this.previewDigest = null;
			this.previewDraftRevision = null;
			this.root.querySelector('[data-preview="panel"]').style.display = 'none';
			this.renderItems();
			this.updateState();
		}, this)).catch(common.notifyError);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
