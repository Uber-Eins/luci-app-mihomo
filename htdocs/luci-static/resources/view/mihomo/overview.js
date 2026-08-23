'use strict';
'require view';
'require dom';
'require poll';
'require ui';
'require mihomo.api as api';
'require mihomo.common as common';

function metric(label, key) {
	return E('div', { 'class': 'mihomo-card metric' }, [
		E('div', { 'class': 'mihomo-metric-label' }, [ label ]),
		E('div', { 'class': 'mihomo-metric-value', 'data-metric': key }, [ '—' ])
	]);
}

function table(headers, name) {
	return E('div', { 'class': 'mihomo-table-wrap' }, [
		E('table', { 'class': 'mihomo-table' }, [
			E('thead', {}, [ E('tr', {}, headers.map(function(header) { return E('th', {}, [ header ]); })) ]),
			E('tbody', { 'data-table': name })
		])
	]);
}

function replaceRows(root, name, rows, columns) {
	const body = root.querySelector('[data-table="' + name + '"]');
	if (!body)
		return;
	if (!rows || !rows.length) {
		dom.content(body, E('tr', {}, [ E('td', { 'colspan': columns, 'class': 'mihomo-empty' }, [ _('No data yet') ]) ]));
		return;
	}
	dom.content(body, rows);
}

function networkSource(label, key) {
	return E('div', { 'class': 'mihomo-network-source' }, [
		E('div', { 'class': 'mihomo-network-label' }, [ label ]),
		E('div', { 'class': 'mihomo-network-value', 'data-network-summary': key }, [ _('Checking') ]),
		E('span', { 'class': 'mihomo-network-address', 'data-network-address': key })
	]);
}

function niceMaximum(value) {
	if (!isFinite(value) || value <= 0)
		return 1;
	const magnitude = Math.pow(10, Math.floor(Math.log(value) / Math.LN10));
	const normalized = value / magnitude;
	const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return step * magnitude;
}

function chartTime(timestamp, range) {
	const date = new Date(timestamp * 1000);
	if (range === '7d' || range === '30d')
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

return view.extend({
	load: function() {
		common.ensureStyle();
		this.range = '1h';
		this.dimension = 'destination';
		this.networkInformation = null;
		this.ipVisible = true;
		this.historyPoints = [];
		this.historyResolution = 60;
		this.historyLastUpdate = 0;
		return Promise.all([
			api.read('overview', { range: this.range }),
			api.read('history', { range: this.range, dimension: this.dimension, limit: 15 })
		]);
	},

	render: function(data) {
		const rangeSelect = E('select', { 'class': 'cbi-input-select', 'aria-label': _('History range') }, [
			E('option', { value: '1h' }, [ _('Last hour') ]),
			E('option', { value: '24h' }, [ _('Last 24 hours') ]),
			E('option', { value: '7d' }, [ _('Last 7 days') ]),
			E('option', { value: '30d' }, [ _('Last 30 days') ])
		]);
		rangeSelect.value = this.range;
		rangeSelect.addEventListener('change', L.bind(function(event) {
			this.range = event.target.value;
			Promise.all([ this.refresh(true, true), this.refreshAggregates() ]);
		}, this));

		const dimensionSelect = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Aggregation dimension') }, [
			E('option', { value: 'destination' }, [ _('Destination') ]),
			E('option', { value: 'source_ip' }, [ _('Source IP') ]),
			E('option', { value: 'process' }, [ _('Process') ]),
			E('option', { value: 'outbound' }, [ _('Outbound') ]),
			E('option', { value: 'proxy_group' }, [ _('Proxy group') ]),
			E('option', { value: 'rule' }, [ _('Rule') ])
		]);
		dimensionSelect.addEventListener('change', L.bind(function(event) {
			this.dimension = event.target.value;
			this.refreshAggregates();
		}, this));

		const serviceButtons = [ 'start', 'stop', 'restart', 'reload' ].map(L.bind(function(action) {
			const labels = { start: _('Start'), stop: _('Stop'), restart: _('Restart'), reload: _('Reload') };
			const button = E('button', {
				'class': 'cbi-button ' + (action === 'start' ? 'cbi-button-apply' : 'cbi-button-action'),
				'type': 'button',
				'data-service-action': action,
				'click': L.bind(this.serviceAction, this, action)
			}, [ labels[action] ]);
			return button;
		}, this));

		this.root = E('div', { 'class': 'mihomo-page' }, [
			E('div', { 'class': 'mihomo-head' }, [
				E('div', {}, [
					E('h2', {}, [ _('Mihomo overview') ]),
					E('div', { 'class': 'mihomo-subtitle' }, [ _('Local statistics are collected silently and retained for 30 days.') ])
				]),
				E('div', { 'class': 'mihomo-toolbar' }, [
					E('span', { 'class': 'mihomo-badge warn', 'data-status': 'badge' }, [ _('Checking') ]),
					rangeSelect
				].concat(serviceButtons))
			]),
			E('div', { 'class': 'mihomo-grid' }, [
				metric(_('Download speed'), 'downloadSpeed'),
				metric(_('Upload speed'), 'uploadSpeed'),
				metric(_('Active connections'), 'active'),
				metric(_('Mihomo memory'), 'memory'),
				metric(_('Downloaded'), 'downloadTotal'),
				metric(_('Uploaded'), 'uploadTotal'),
				E('section', { 'class': 'mihomo-card wide' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('h3', {}, [ _('Traffic history') ]),
						E('div', { 'class': 'mihomo-inline mihomo-chart-legend' }, [
							E('span', { 'class': 'mihomo-chart-key download' }, [ _('Download') ]),
							E('span', { 'class': 'mihomo-chart-key upload' }, [ _('Upload') ])
						])
					]),
					E('canvas', { 'class': 'mihomo-chart', 'data-chart': 'traffic', 'aria-label': _('Traffic history chart') })
				]),
				E('section', { 'class': 'mihomo-card' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('h3', {}, [ _('Network information') ]),
						E('div', { 'class': 'mihomo-inline' }, [
							E('button', { 'class': 'cbi-button', 'type': 'button', 'data-network': 'toggle', 'disabled': true, 'click': L.bind(this.togglePublicIP, this) }, [ _('Hide') ]),
							E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'data-network': 'fetch', 'click': L.bind(this.fetchPublicIP, this) }, [ _('Refresh') ])
						])
					]),
					E('div', { 'class': 'mihomo-network-sources' }, [
						networkSource('ipip.net', 'ipip'),
						networkSource('ip.sb', 'ipsb')
					])
				]),
				E('section', { 'class': 'mihomo-card wide' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Historical usage') ]), dimensionSelect ]),
					table([ _('Name'), _('Connections'), _('Download'), _('Upload') ], 'aggregates')
				]),
				E('section', { 'class': 'mihomo-card' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Rule hits') ]) ]),
					table([ _('Rule'), _('Proxy'), _('Hits') ], 'rules')
				]),
				E('section', { 'class': 'mihomo-card full' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('div', {}, [ E('h3', {}, [ _('Statistics storage') ]), E('div', { 'class': 'mihomo-muted' }, [ _('Minute samples and daily connection aggregates are stored locally.') ]) ]),
						E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'click': L.bind(this.clearHistory, this) }, [ _('Clear history') ])
					])
				])
			])
		]);

		this.updateOverview(data[0]);
		this.updateAggregates(data[1]);
		this.fetchPublicIP();
		poll.add(L.bind(this.refresh, this, false, false), 2);
		return this.root;
	},

	refresh: function(showErrors, forceHistory) {
		const includeHistory = forceHistory || Date.now() - this.historyLastUpdate >= 10000;
		if (includeHistory)
			this.historyLastUpdate = Date.now();
		return api.read('overview', { range: this.range, history: includeHistory ? 1 : 0 }).then(L.bind(function(data) {
			this.updateOverview(data);
		}, this)).catch(L.bind(function(error) {
			if (includeHistory)
				this.historyLastUpdate = 0;
			this.setStatus(false, false, error.message);
			if (showErrors)
				common.notifyError(error);
		}, this));
	},

	refreshAggregates: function() {
		return api.read('history', { range: this.range, dimension: this.dimension, limit: 15 }).then(L.bind(this.updateAggregates, this)).catch(common.notifyError);
	},

	updateOverview: function(data) {
		if (!this.root || !data)
			return;
		const current = data.current || {};
		common.text(this.root.querySelector('[data-metric="downloadSpeed"]'), common.formatBytes(current.downloadSpeed, true));
		common.text(this.root.querySelector('[data-metric="uploadSpeed"]'), common.formatBytes(current.uploadSpeed, true));
		common.text(this.root.querySelector('[data-metric="active"]'), current.active || 0);
		common.text(this.root.querySelector('[data-metric="memory"]'), common.formatBytes(current.memory));
		common.text(this.root.querySelector('[data-metric="downloadTotal"]'), common.formatBytes(current.downloadTotal));
		common.text(this.root.querySelector('[data-metric="uploadTotal"]'), common.formatBytes(current.uploadTotal));
		this.setStatus(!!data.serviceRunning, !!current.connected, current.lastError);
		if (Array.isArray(data.history)) {
			this.historyResolution = Number(data.resolutionSeconds) || 60;
			this.historyLastUpdate = Date.now();
			this.drawTraffic(data.history);
		}
		this.updateRules(current.rules || []);
	},

	setStatus: function(running, connected, detail) {
		const badge = this.root && this.root.querySelector('[data-status="badge"]');
		if (!badge)
			return;
		badge.className = 'mihomo-badge ' + (connected ? 'good' : running ? 'warn' : 'bad');
		badge.textContent = connected ? _('Running · connected') : running ? _('Running · controller unavailable') : _('Stopped');
		badge.title = detail || '';
		const start = this.root.querySelector('[data-service-action="start"]');
		const stop = this.root.querySelector('[data-service-action="stop"]');
		if (start) start.disabled = running;
		if (stop) stop.disabled = !running;
	},

	drawTraffic: function(points) {
		this.historyPoints = Array.isArray(points) ? points.slice() : [];
		const canvas = this.root.querySelector('[data-chart="traffic"]');
		if (!canvas)
			return;
		const bounds = canvas.getBoundingClientRect();
		if (bounds.width < 1 || bounds.height < 1) {
			if (!this.chartFrame) {
				this.chartFrame = requestAnimationFrame(L.bind(function() {
					this.chartFrame = null;
					this.drawTraffic(this.historyPoints);
				}, this));
			}
			return;
		}
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(Math.round(bounds.width), 320);
		const height = Math.max(Math.round(bounds.height), 220);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		const context = canvas.getContext('2d');
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		const styles = getComputedStyle(document.documentElement);
		const border = styles.getPropertyValue('--mihomo-border').trim() || 'rgba(127,127,127,.22)';
		const muted = styles.getPropertyValue('--mihomo-muted').trim() || '#667085';
		const left = 64;
		const right = 12;
		const top = 14;
		const bottom = 28;
		const plotWidth = width - left - right;
		const plotHeight = height - top - bottom;
		const durations = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 };
		const duration = durations[this.range] || durations['1h'];
		const latestTimestamp = this.historyPoints.reduce(function(latest, point) {
			return Math.max(latest, Number(point.timestamp) || 0);
		}, 0);
		const end = Math.max(Date.now() / 1000, latestTimestamp);
		const start = end - duration;
		const visible = this.historyPoints.filter(function(point) {
			const timestamp = Number(point.timestamp) || 0;
			return timestamp >= start && timestamp <= end;
		});
		let rawMaximum = 0;
		visible.forEach(function(point) {
			rawMaximum = Math.max(rawMaximum, Number(point.download) || 0, Number(point.upload) || 0);
		});
		const maximum = niceMaximum(rawMaximum);

		context.font = '11px system-ui, sans-serif';
		context.lineWidth = 1;
		for (let i = 0; i <= 4; i++) {
			const y = top + plotHeight * i / 4;
			context.strokeStyle = border;
			context.beginPath();
			context.moveTo(left, y);
			context.lineTo(width - right, y);
			context.stroke();
			context.fillStyle = muted;
			context.textAlign = 'right';
			context.textBaseline = 'middle';
			context.fillText(common.formatBytes(maximum * (1 - i / 4), true), left - 8, y);
		}
		for (let i = 0; i <= 4; i++) {
			const x = left + plotWidth * i / 4;
			context.fillStyle = muted;
			context.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
			context.textBaseline = 'bottom';
			context.fillText(chartTime(start + duration * i / 4, this.range), x, height);
		}

		if (!visible.length) {
			context.fillStyle = muted;
			context.textAlign = 'center';
			context.textBaseline = 'middle';
			context.fillText(_('No history yet'), left + plotWidth / 2, top + plotHeight / 2);
			return;
		}
		const resolution = Math.max(Number(this.historyResolution) || 60, 1);
		const plot = function(key, color) {
			context.beginPath();
			context.strokeStyle = color;
			context.lineWidth = 2.25;
			context.lineJoin = 'round';
			context.lineCap = 'round';
			let previous = null;
			visible.forEach(function(point) {
				const timestamp = Number(point.timestamp) || 0;
				const x = left + plotWidth * ((timestamp - start) / duration);
				const y = top + plotHeight * (1 - Math.min((Number(point[key]) || 0) / maximum, 1));
				if (previous == null || timestamp - previous > resolution * 2.5)
					context.moveTo(x, y);
				else
					context.lineTo(x, y);
				previous = timestamp;
			});
			context.stroke();
		};
		plot('download', '#3b82f6');
		plot('upload', '#a855f7');
	},

	updateAggregates: function(data) {
		const rows = (data.aggregates || []).map(function(item) {
			return E('tr', {}, [ E('td', { 'class': 'mihomo-mono' }, [ item.key ]), E('td', {}, [ String(item.count) ]), E('td', {}, [ common.formatBytes(item.download) ]), E('td', {}, [ common.formatBytes(item.upload) ]) ]);
		});
		replaceRows(this.root, 'aggregates', rows, 4);
	},

	updateRules: function(rules) {
		const rows = rules.slice(0, 25).map(function(item) {
			const label = item.type + (item.payload ? ' / ' + item.payload : '');
			return E('tr', {}, [ E('td', { 'class': 'mihomo-mono' }, [ label ]), E('td', {}, [ item.proxy || '—' ]), E('td', {}, [ String(item.hitCount || 0) ]) ]);
		});
		replaceRows(this.root, 'rules', rows, 3);
	},

	serviceAction: function(action, event) {
		if ((action === 'stop' || action === 'restart') && !window.confirm(action === 'stop' ? _('Stop Mihomo now?') : _('Restart Mihomo now?')))
			return;
		const button = event.currentTarget;
		common.setBusy(button, true);
		api.write('service-action', { action: action }).then(L.bind(function() {
			common.notifySuccess(_('Mihomo service action completed.'));
			return this.refresh(true, false);
		}, this)).catch(common.notifyError).finally(function() { common.setBusy(button, false); });
	},

	fetchPublicIP: function(event) {
		const button = event && event.currentTarget ? event.currentTarget : this.root.querySelector('[data-network="fetch"]');
		this.networkInformation = null;
		this.renderPublicIP();
		common.setBusy(button, true);
		api.write('public-ip', {}).then(L.bind(function(data) {
			this.networkInformation = data || {};
			this.renderPublicIP();
		}, this)).catch(L.bind(function(error) {
			this.networkInformation = {
				ipip: { error: error.message },
				ipsb: { error: error.message }
			};
			this.renderPublicIP();
		}, this)).finally(function() { common.setBusy(button, false); });
	},

	togglePublicIP: function() {
		this.ipVisible = !this.ipVisible;
		this.renderPublicIP();
	},

	renderPublicIP: function() {
		const information = this.networkInformation;
		let hasAddress = false;
		[ 'ipip', 'ipsb' ].forEach(L.bind(function(key) {
			const source = information && information[key] ? information[key] : null;
			const summary = this.root.querySelector('[data-network-summary="' + key + '"]');
			const address = this.root.querySelector('[data-network-address="' + key + '"]');
			if (!source) {
				summary.textContent = _('Checking');
				summary.classList.remove('error');
				summary.title = '';
				address.textContent = '';
				return;
			}
			if (source.error) {
				summary.textContent = _('Query failed');
				summary.classList.add('error');
				summary.title = source.error;
				address.textContent = '';
				return;
			}
			hasAddress = hasAddress || !!source.address;
			summary.textContent = source.summary || source.family || '—';
			summary.classList.remove('error');
			summary.title = '';
			address.textContent = source.address ? ' (' + (this.ipVisible ? source.address : '••••••••') + ')' : '';
		}, this));
		const toggle = this.root.querySelector('[data-network="toggle"]');
		toggle.disabled = !hasAddress;
		toggle.textContent = this.ipVisible ? _('Hide') : _('Reveal');
	},

	clearHistory: function() {
		if (!window.confirm(_('Permanently clear all locally recorded Mihomo history?')))
			return;
		api.write('history-clear', {}).then(L.bind(function() {
			common.notifySuccess(_('Statistics history cleared.'));
			return Promise.all([ this.refresh(true, true), this.refreshAggregates() ]);
		}, this)).catch(common.notifyError);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
