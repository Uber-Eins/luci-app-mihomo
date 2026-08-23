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

function svgElement(name, attributes, text) {
	const node = document.createElementNS('http://www.w3.org/2000/svg', name);
	Object.keys(attributes || {}).forEach(function(key) { node.setAttribute(key, attributes[key]); });
	if (text != null)
		node.textContent = text;
	return node;
}

function shortLabel(value, length) {
	value = value || _('Unknown');
	return value.length > length ? value.slice(0, length - 1) + '…' : value;
}

return view.extend({
	load: function() {
		common.ensureStyle();
		this.range = '1h';
		this.dimension = 'destination';
		this.ipAddress = null;
		this.ipVisible = false;
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
						E('div', { 'class': 'mihomo-inline mihomo-muted' }, [
							E('span', {}, [ '● ', _('Download') ]), E('span', {}, [ '● ', _('Upload') ])
						])
					]),
					E('canvas', { 'class': 'mihomo-chart', 'data-chart': 'traffic', 'aria-label': _('Traffic history chart') })
				]),
				E('section', { 'class': 'mihomo-card' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Public IP') ]) ]),
					E('p', { 'class': 'mihomo-muted' }, [ _('Requested only when you press the button, through the configured Mihomo proxy.') ]),
					E('p', { 'class': 'mihomo-ip', 'data-ip': 'value' }, [ _('Not requested') ]),
					E('div', { 'class': 'mihomo-toolbar' }, [
						E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'data-ip': 'fetch', 'click': L.bind(this.fetchPublicIP, this) }, [ _('Check public IP') ]),
						E('button', { 'class': 'cbi-button', 'type': 'button', 'data-ip': 'toggle', 'disabled': true, 'click': L.bind(this.togglePublicIP, this) }, [ _('Hide') ])
					])
				]),
				E('section', { 'class': 'mihomo-card full' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Live topology') ]), E('span', { 'class': 'mihomo-muted' }, [ _('Up to 25 busiest active connections') ]) ]),
					svgElement('svg', { 'class': 'mihomo-topology', 'data-topology': 'graph', 'viewBox': '0 0 900 310', 'role': 'img', 'aria-label': _('Connection topology') })
				]),
				E('section', { 'class': 'mihomo-card wide' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Historical usage') ]), dimensionSelect ]),
					table([ _('Name'), _('Connections'), _('Download'), _('Upload') ], 'aggregates')
				]),
				E('section', { 'class': 'mihomo-card' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Proxy providers') ]) ]),
					table([ _('Provider'), _('Healthy'), _('Usage') ], 'providers')
				]),
				E('section', { 'class': 'mihomo-card' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Rule hits') ]) ]),
					table([ _('Rule'), _('Proxy'), _('Hits') ], 'rules')
				]),
				E('section', { 'class': 'mihomo-card wide' }, [
					E('div', { 'class': 'mihomo-card-head' }, [ E('h3', {}, [ _('Active connections') ]) ]),
					table([ _('Source'), _('Destination'), _('Route'), _('Traffic') ], 'connections')
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
		poll.add(L.bind(this.refresh, this, false, false), 2);
		return this.root;
	},

	refresh: function(showErrors, includeHistory) {
		return api.read('overview', { range: this.range, history: includeHistory ? 1 : 0 }).then(L.bind(function(data) {
			this.updateOverview(data);
		}, this)).catch(L.bind(function(error) {
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
		if (Array.isArray(data.history))
			this.drawTraffic(data.history);
		this.drawTopology(current.connections || []);
		this.updateProviders(current.providers || []);
		this.updateRules(current.rules || []);
		this.updateConnections(current.connections || []);
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
		const canvas = this.root.querySelector('[data-chart="traffic"]');
		if (!canvas)
			return;
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(canvas.clientWidth, 320);
		const height = Math.max(canvas.clientHeight, 180);
		canvas.width = width * ratio;
		canvas.height = height * ratio;
		const context = canvas.getContext('2d');
		context.scale(ratio, ratio);
		context.clearRect(0, 0, width, height);
		const styles = getComputedStyle(document.documentElement);
		const muted = styles.getPropertyValue('--mihomo-border') || 'rgba(127,127,127,.22)';
		context.strokeStyle = muted;
		context.lineWidth = 1;
		for (let i = 1; i < 4; i++) {
			const y = (height - 24) * i / 4;
			context.beginPath(); context.moveTo(38, y); context.lineTo(width - 8, y); context.stroke();
		}
		if (!points.length) {
			context.fillStyle = styles.getPropertyValue('--mihomo-muted') || '#667085';
			context.textAlign = 'center';
			context.fillText(_('No history yet'), width / 2, height / 2);
			return;
		}
		let maximum = 1;
		points.forEach(function(point) { maximum = Math.max(maximum, Number(point.download) || 0, Number(point.upload) || 0); });
		const plot = function(key, color) {
			context.beginPath();
			context.strokeStyle = color;
			context.lineWidth = 2;
			points.forEach(function(point, index) {
				const x = 38 + (width - 50) * (points.length === 1 ? 0 : index / (points.length - 1));
				const y = height - 22 - (height - 36) * ((Number(point[key]) || 0) / maximum);
				if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
			});
			context.stroke();
		};
		plot('download', '#3b82f6');
		plot('upload', '#a855f7');
		context.fillStyle = styles.getPropertyValue('--mihomo-muted') || '#667085';
		context.font = '11px sans-serif';
		context.textAlign = 'left';
		context.fillText(common.formatBytes(maximum, true), 2, 12);
		context.fillText('0', 18, height - 18);
	},

	drawTopology: function(connections) {
		const svg = this.root.querySelector('[data-topology="graph"]');
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		if (!connections.length) {
			svg.appendChild(svgElement('text', { x: 450, y: 155, 'text-anchor': 'middle', fill: 'currentColor', opacity: '.55' }, _('No active connections')));
			return;
		}
		connections = connections.slice().sort(function(a, b) { return (b.upload + b.download) - (a.upload + a.download); }).slice(0, 25);
		const unique = function(values) { return Array.from(new Set(values)).slice(0, 12); };
		const sources = unique(connections.map(function(item) { return item.source || _('Unknown'); }));
		const routes = unique(connections.map(function(item) { return (item.chains || []).join(' → ') || _('Direct'); }));
		const destinations = unique(connections.map(function(item) { return item.destination || _('Unknown'); }));
		const y = function(list, value) { const index = Math.max(0, list.indexOf(value)); return 35 + index * (240 / Math.max(1, list.length - 1)); };
		connections.forEach(function(item) {
			const source = item.source || _('Unknown');
			const route = (item.chains || []).join(' → ') || _('Direct');
			const destination = item.destination || _('Unknown');
			if (!sources.includes(source) || !routes.includes(route) || !destinations.includes(destination)) return;
			svg.appendChild(svgElement('path', { d: 'M 145 ' + y(sources, source) + ' C 260 ' + y(sources, source) + ', 285 ' + y(routes, route) + ', 400 ' + y(routes, route), fill: 'none', stroke: '#60a5fa', 'stroke-opacity': '.28', 'stroke-width': '1.5' }));
			svg.appendChild(svgElement('path', { d: 'M 500 ' + y(routes, route) + ' C 615 ' + y(routes, route) + ', 640 ' + y(destinations, destination) + ', 755 ' + y(destinations, destination), fill: 'none', stroke: '#a78bfa', 'stroke-opacity': '.28', 'stroke-width': '1.5' }));
		});
		const drawColumn = function(list, x, anchor) {
			list.forEach(function(label) {
				const position = y(list, label);
				svg.appendChild(svgElement('circle', { cx: x, cy: position, r: 4, fill: '#3b82f6' }));
				svg.appendChild(svgElement('text', { x: x + (anchor === 'end' ? -9 : 9), y: position + 4, 'text-anchor': anchor, fill: 'currentColor', 'font-size': '11' }, shortLabel(label, 28)));
			});
		};
		drawColumn(sources, 145, 'end'); drawColumn(routes, 450, 'middle'); drawColumn(destinations, 755, 'start');
	},

	updateAggregates: function(data) {
		const rows = (data.aggregates || []).map(function(item) {
			return E('tr', {}, [ E('td', { 'class': 'mihomo-mono' }, [ item.key ]), E('td', {}, [ String(item.count) ]), E('td', {}, [ common.formatBytes(item.download) ]), E('td', {}, [ common.formatBytes(item.upload) ]) ]);
		});
		replaceRows(this.root, 'aggregates', rows, 4);
	},

	updateProviders: function(providers) {
		const rows = providers.map(function(item) {
			const usage = item.limit ? common.formatBytes(item.used) + ' / ' + common.formatBytes(item.limit) : '—';
			return E('tr', {}, [ E('td', {}, [ item.name ]), E('td', {}, [ item.alive + ' / ' + item.total ]), E('td', {}, [ usage ]) ]);
		});
		replaceRows(this.root, 'providers', rows, 3);
	},

	updateRules: function(rules) {
		const rows = rules.slice(0, 25).map(function(item) {
			const label = item.type + (item.payload ? ' / ' + item.payload : '');
			return E('tr', {}, [ E('td', { 'class': 'mihomo-mono' }, [ label ]), E('td', {}, [ item.proxy || '—' ]), E('td', {}, [ String(item.hitCount || 0) ]) ]);
		});
		replaceRows(this.root, 'rules', rows, 3);
	},

	updateConnections: function(connections) {
		const rows = connections.slice(0, 100).map(function(item) {
			return E('tr', {}, [
				E('td', { 'class': 'mihomo-mono' }, [ item.source || '—' ]),
				E('td', { 'class': 'mihomo-mono' }, [ item.destination || '—' ]),
				E('td', {}, [ (item.chains || []).join(' → ') || _('Direct') ]),
				E('td', {}, [ '↓ ' + common.formatBytes(item.download) + ' · ↑ ' + common.formatBytes(item.upload) ])
			]);
		});
		replaceRows(this.root, 'connections', rows, 4);
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
		const button = event.currentTarget;
		common.setBusy(button, true);
		api.write('public-ip', {}).then(L.bind(function(data) {
			this.ipAddress = data.address;
			this.ipVisible = true;
			this.renderPublicIP();
		}, this)).catch(common.notifyError).finally(function() { common.setBusy(button, false); });
	},

	togglePublicIP: function() {
		this.ipVisible = !this.ipVisible;
		this.renderPublicIP();
	},

	renderPublicIP: function() {
		const value = this.root.querySelector('[data-ip="value"]');
		const toggle = this.root.querySelector('[data-ip="toggle"]');
		if (!this.ipAddress) {
			value.textContent = _('Not requested'); toggle.disabled = true; return;
		}
		value.textContent = this.ipVisible ? this.ipAddress : '••••••••';
		toggle.disabled = false;
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
