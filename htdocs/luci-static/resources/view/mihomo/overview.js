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

function chartTime(timestamp) {
	return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortLabel(value, maximum) {
	value = String(value || _('Unknown'));
	return value.length > maximum ? value.slice(0, maximum - 1) + '…' : value;
}

function formatCount(value) {
	return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
}

return view.extend({
	load: function() {
		common.ensureStyle();
		this.range = '1h';
		this.dimension = 'destination';
		this.serviceRunning = false;
		this.controllerConnected = false;
		this.networkInformation = null;
		this.networkRequest = 0;
		this.ipVisible = true;
		this.realtimePoints = [];
		this.ruleItems = [];
		return Promise.all([
			api.read('overview'),
			api.read('realtime').catch(function() { return null; }),
			api.read('history', { range: this.range, dimension: this.dimension, limit: 15 }),
			api.read('rules', { limit: 40 }).catch(function() { return { rules: [] }; })
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
			this.refreshAggregates();
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
			return E('button', {
				'class': 'cbi-button ' + (action === 'start' ? 'cbi-button-apply' : 'cbi-button-action'),
				'type': 'button',
				'data-service-action': action,
				'click': L.bind(this.serviceAction, this, action)
			}, [ labels[action] ]);
		}, this));

		this.root = E('div', { 'class': 'mihomo-page' }, [
			E('div', { 'class': 'mihomo-head' }, [
				E('div', {}, [
					E('h2', {}, [ _('Mihomo overview') ]),
					E('div', { 'class': 'mihomo-subtitle' }, [ _('Local statistics are collected silently and retained for 30 days.') ])
				]),
				E('div', { 'class': 'mihomo-toolbar' }, [
					E('span', { 'class': 'mihomo-badge warn', 'data-status': 'badge' }, [ _('Checking') ])
				].concat(serviceButtons))
			]),
			E('div', { 'class': 'mihomo-grid' }, [
				metric(_('Active connections'), 'active'),
				metric(_('Mihomo memory'), 'memory'),
				metric(_('Downloaded'), 'downloadTotal'),
				metric(_('Uploaded'), 'uploadTotal'),
				E('section', { 'class': 'mihomo-card wide mihomo-realtime-card' }, [
					E('div', { 'class': 'mihomo-card-head mihomo-realtime-head' }, [
						E('div', {}, [
							E('h3', {}, [ _('Real-time traffic') ]),
							E('div', { 'class': 'mihomo-muted' }, [ _('Last 60 seconds · refreshed every second') ])
						]),
						E('div', { 'class': 'mihomo-realtime-values' }, [
							E('div', { 'class': 'mihomo-live-speed download' }, [
								E('span', { 'class': 'mihomo-live-label' }, [ _('Download') ]),
								E('strong', { 'data-live-speed': 'download' }, [ '—' ])
							]),
							E('div', { 'class': 'mihomo-live-speed upload' }, [
								E('span', { 'class': 'mihomo-live-label' }, [ _('Upload') ]),
								E('strong', { 'data-live-speed': 'upload' }, [ '—' ])
							])
						])
					]),
					E('canvas', { 'class': 'mihomo-chart mihomo-realtime-chart', 'data-chart': 'realtime', 'aria-label': _('Real-time traffic chart') })
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
				E('section', { 'class': 'mihomo-card full' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('h3', {}, [ _('Historical usage') ]),
						E('div', { 'class': 'mihomo-inline' }, [ dimensionSelect, rangeSelect ])
					]),
					table([ _('Name'), _('Connections'), _('Download'), _('Upload') ], 'aggregates')
				]),
				E('section', { 'class': 'mihomo-card full' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('div', {}, [
							E('h3', {}, [ _('Rule hits') ]),
							E('div', { 'class': 'mihomo-muted' }, [ _('Hover over a bar to inspect the rule.') ])
						])
					]),
					E('div', { 'class': 'mihomo-rule-chart-wrap' }, [
						E('canvas', { 'class': 'mihomo-rule-chart', 'data-chart': 'rules', 'aria-label': _('Rule hit chart') }),
						E('div', { 'class': 'mihomo-chart-tooltip', 'data-rule-tooltip': 'details', 'hidden': true })
					])
				]),
				E('section', { 'class': 'mihomo-card full' }, [
					E('div', { 'class': 'mihomo-card-head' }, [
						E('div', {}, [ E('h3', {}, [ _('Statistics storage') ]), E('div', { 'class': 'mihomo-muted' }, [ _('Minute samples and daily connection aggregates are stored locally.') ]) ]),
						E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'click': L.bind(this.clearHistory, this) }, [ _('Clear history') ])
					])
				])
			])
		]);

		const ruleCanvas = this.root.querySelector('[data-chart="rules"]');
		ruleCanvas.addEventListener('pointermove', L.bind(this.rulePointerMove, this));
		ruleCanvas.addEventListener('pointerleave', L.bind(this.hideRuleTooltip, this));
		this.updateOverview(data[0]);
		this.updateRealtime(data[1]);
		this.updateAggregates(data[2]);
		this.updateRules(data[3]);
		this.fetchPublicIP();
		poll.add(L.bind(this.refreshRealtime, this), 1);
		poll.add(L.bind(this.refreshOverview, this), 5);
		poll.add(L.bind(this.refreshRules, this), 10);
		return this.root;
	},

	refreshRealtime: function() {
		return api.read('realtime').then(L.bind(this.updateRealtime, this)).catch(L.bind(function(error) {
			this.controllerConnected = false;
			this.setStatus(this.serviceRunning, false, error.message);
		}, this));
	},

	refreshOverview: function() {
		return api.read('overview').then(L.bind(this.updateOverview, this)).catch(L.bind(function(error) {
			this.setStatus(false, false, error.message);
		}, this));
	},

	refreshRules: function() {
		return api.read('rules', { limit: 40 }).then(L.bind(this.updateRules, this)).catch(function() {});
	},

	refreshAggregates: function() {
		return api.read('history', { range: this.range, dimension: this.dimension, limit: 15 }).then(L.bind(this.updateAggregates, this)).catch(common.notifyError);
	},

	updateOverview: function(data) {
		if (!this.root || !data)
			return;
		const current = data.current || {};
		this.serviceRunning = !!data.serviceRunning;
		this.controllerConnected = !!current.connected;
		this.setStatus(this.serviceRunning, this.controllerConnected, current.lastError);
	},

	updateRealtime: function(data) {
		if (!this.root || !data)
			return;
		this.controllerConnected = !!data.connected;
		common.text(this.root.querySelector('[data-live-speed="download"]'), common.formatBytes(data.downloadSpeed, true));
		common.text(this.root.querySelector('[data-live-speed="upload"]'), common.formatBytes(data.uploadSpeed, true));
		common.text(this.root.querySelector('[data-metric="active"]'), data.active || 0);
		common.text(this.root.querySelector('[data-metric="memory"]'), common.formatBytes(data.memory));
		common.text(this.root.querySelector('[data-metric="downloadTotal"]'), common.formatBytes(data.downloadTotal));
		common.text(this.root.querySelector('[data-metric="uploadTotal"]'), common.formatBytes(data.uploadTotal));
		this.setStatus(this.serviceRunning, this.controllerConnected, data.lastError);
		this.appendRealtimePoint({
			timestamp: Date.now() / 1000,
			download: Number(data.downloadSpeed) || 0,
			upload: Number(data.uploadSpeed) || 0
		});
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

	appendRealtimePoint: function(point) {
		const points = this.realtimePoints;
		if (points.length && points[points.length - 1].timestamp === point.timestamp)
			points[points.length - 1] = point;
		else
			points.push(point);
		const cutoff = point.timestamp - 65;
		while (points.length && points[0].timestamp < cutoff)
			points.shift();
		this.drawRealtime();
	},

	drawRealtime: function() {
		const canvas = this.root.querySelector('[data-chart="realtime"]');
		if (!canvas)
			return;
		const bounds = canvas.getBoundingClientRect();
		if (bounds.width < 1 || bounds.height < 1) {
			if (!this.realtimeFrame) {
				this.realtimeFrame = requestAnimationFrame(L.bind(function() {
					this.realtimeFrame = null;
					this.drawRealtime();
				}, this));
			}
			return;
		}
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(Math.round(bounds.width), 320);
		const height = Math.max(Math.round(bounds.height), 240);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		const context = canvas.getContext('2d');
		if (!context)
			return;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		const styles = getComputedStyle(document.documentElement);
		const border = styles.getPropertyValue('--mihomo-border').trim() || 'rgba(127,127,127,.22)';
		const muted = styles.getPropertyValue('--mihomo-muted').trim() || '#667085';
		const left = 64, right = 12, top = 14, bottom = 28;
		const plotWidth = width - left - right;
		const plotHeight = height - top - bottom;
		const latest = this.realtimePoints.length ? this.realtimePoints[this.realtimePoints.length - 1].timestamp : Math.floor(Date.now() / 1000);
		const end = Math.max(Date.now() / 1000, latest);
		const start = end - 60;
		const visible = this.realtimePoints.filter(function(point) { return point.timestamp >= start && point.timestamp <= end; });
		let rawMaximum = 0;
		visible.forEach(function(point) { rawMaximum = Math.max(rawMaximum, point.download, point.upload); });
		const maximum = niceMaximum(rawMaximum);

		context.font = '11px system-ui, sans-serif';
		context.lineWidth = 1;
		for (let i = 0; i <= 4; i++) {
			const y = top + plotHeight * i / 4;
			context.strokeStyle = border;
			context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
			context.fillStyle = muted;
			context.textAlign = 'right'; context.textBaseline = 'middle';
			context.fillText(common.formatBytes(maximum * (1 - i / 4), true), left - 8, y);
		}
		for (let i = 0; i <= 3; i++) {
			const x = left + plotWidth * i / 3;
			context.fillStyle = muted;
			context.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
			context.textBaseline = 'bottom';
			context.fillText(chartTime(start + 60 * i / 3), x, height);
		}
		if (!visible.length) {
			context.fillStyle = muted; context.textAlign = 'center'; context.textBaseline = 'middle';
			context.fillText(_('Waiting for real-time traffic'), left + plotWidth / 2, top + plotHeight / 2);
			return;
		}
		const plot = function(key, color) {
			context.beginPath();
			context.strokeStyle = color;
			context.lineWidth = 2.25;
			context.lineJoin = 'round';
			context.lineCap = 'round';
			let previous = null;
			visible.forEach(function(point) {
				const x = left + plotWidth * ((point.timestamp - start) / 60);
				const y = top + plotHeight * (1 - Math.min(point[key] / maximum, 1));
				if (previous == null || point.timestamp - previous > 3)
					context.moveTo(x, y);
				else
					context.lineTo(x, y);
				previous = point.timestamp;
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

	updateRules: function(data) {
		this.ruleItems = data && Array.isArray(data.rules) ? data.rules.slice(0, 40) : [];
		this.drawRuleHits();
	},

	drawRuleHits: function(hovered) {
		const canvas = this.root.querySelector('[data-chart="rules"]');
		if (!canvas)
			return;
		const bounds = canvas.getBoundingClientRect();
		if (bounds.width < 1 || bounds.height < 1) {
			if (!this.ruleFrame) {
				this.ruleFrame = requestAnimationFrame(L.bind(function() {
					this.ruleFrame = null;
					this.drawRuleHits();
				}, this));
			}
			return;
		}
		const ratio = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(Math.round(bounds.width), 320);
		const height = Math.max(Math.round(bounds.height), 280);
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		const context = canvas.getContext('2d');
		if (!context)
			return;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		const styles = getComputedStyle(document.documentElement);
		const border = styles.getPropertyValue('--mihomo-border').trim() || 'rgba(127,127,127,.22)';
		const muted = styles.getPropertyValue('--mihomo-muted').trim() || '#667085';
		const left = 62, right = 12, top = 24, bottom = 70;
		const plotWidth = width - left - right;
		const plotHeight = height - top - bottom;
		const maximumBars = Math.max(1, Math.min(40, Math.floor(plotWidth / 24)));
		const items = this.ruleItems.slice(0, maximumBars);
		if (!items.length) {
			context.fillStyle = muted; context.font = '12px system-ui, sans-serif';
			context.textAlign = 'center'; context.textBaseline = 'middle';
			context.fillText(_('No rule hits yet'), width / 2, height / 2);
			this.ruleBars = [];
			return;
		}
		let rawMaximum = 0;
		items.forEach(function(item) { rawMaximum = Math.max(rawMaximum, Number(item.hitCount) || 0); });
		const maximum = niceMaximum(rawMaximum);
		context.font = '11px system-ui, sans-serif';
		for (let i = 0; i <= 5; i++) {
			const y = top + plotHeight * i / 5;
			context.strokeStyle = border; context.lineWidth = 1;
			context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
			context.fillStyle = muted; context.textAlign = 'right'; context.textBaseline = 'middle';
			context.fillText(formatCount(maximum * (1 - i / 5)), left - 8, y);
		}
		const slot = plotWidth / items.length;
		const barWidth = Math.max(3, Math.min(48, slot * .72));
		const labelCapacity = Math.max(1, Math.floor(plotWidth / 150));
		const labelStep = Math.max(1, Math.ceil(items.length / labelCapacity));
		const gradient = context.createLinearGradient(0, top, 0, top + plotHeight);
		gradient.addColorStop(0, 'rgba(129, 140, 248, .88)');
		gradient.addColorStop(1, 'rgba(99, 102, 241, .42)');
		this.ruleBars = [];
		items.forEach(L.bind(function(item, index) {
			const value = Math.max(0, Number(item.hitCount) || 0);
			const x = left + slot * index + (slot - barWidth) / 2;
			const barHeight = plotHeight * Math.min(value / maximum, 1);
			const y = top + plotHeight - barHeight;
			context.fillStyle = index === hovered ? 'rgba(165, 180, 252, 1)' : gradient;
			context.fillRect(x, y, barWidth, Math.max(barHeight, value ? 1 : 0));
			if (barWidth >= 18) {
				context.fillStyle = muted; context.font = '10px system-ui, sans-serif';
				context.textAlign = 'center'; context.textBaseline = 'bottom';
				context.fillText(formatCount(value), x + barWidth / 2, Math.max(top + 11, y - 3));
			}
			if (index % labelStep === 0) {
				context.fillStyle = muted; context.font = '10px system-ui, sans-serif';
				context.textAlign = 'center'; context.textBaseline = 'top';
				context.fillText(shortLabel(item.type, 18), x + barWidth / 2, top + plotHeight + 9);
				if (item.payload)
					context.fillText(shortLabel(item.payload, 22), x + barWidth / 2, top + plotHeight + 23);
			}
			this.ruleBars.push({ x: x, width: barWidth, slotStart: left + slot * index, slotEnd: left + slot * (index + 1), item: item, index: index });
		}, this));
	},

	rulePointerMove: function(event) {
		const canvas = event.currentTarget;
		const bounds = canvas.getBoundingClientRect();
		const x = event.clientX - bounds.left;
		let match = null;
		(this.ruleBars || []).some(function(bar) {
			if (x >= bar.slotStart && x <= bar.slotEnd) {
				match = bar;
				return true;
			}
			return false;
		});
		if (!match) {
			this.hideRuleTooltip();
			return;
		}
		if (this.hoveredRule !== match.index) {
			this.hoveredRule = match.index;
			this.drawRuleHits(match.index);
		}
		canvas.style.cursor = 'pointer';
		const tooltip = this.root.querySelector('[data-rule-tooltip="details"]');
		const wrapper = tooltip.parentNode;
		const wrapperBounds = wrapper.getBoundingClientRect();
		const item = match.item;
		dom.content(tooltip, [
			E('strong', {}, [ item.type + (item.payload ? ' ' + item.payload : '') ]),
			E('span', {}, [ _('Proxy') + ': ' + (item.proxy || '—') ]),
			E('span', {}, [ _('Hits') + ': ' + formatCount(item.hitCount) ])
		]);
		tooltip.hidden = false;
		let left = event.clientX - wrapperBounds.left + 12;
		let top = event.clientY - wrapperBounds.top + 12;
		left = Math.max(6, Math.min(left, wrapperBounds.width - tooltip.offsetWidth - 6));
		top = Math.max(6, Math.min(top, wrapperBounds.height - tooltip.offsetHeight - 6));
		tooltip.style.left = left + 'px';
		tooltip.style.top = top + 'px';
	},

	hideRuleTooltip: function() {
		const tooltip = this.root && this.root.querySelector('[data-rule-tooltip="details"]');
		const canvas = this.root && this.root.querySelector('[data-chart="rules"]');
		if (tooltip)
			tooltip.hidden = true;
		if (canvas)
			canvas.style.cursor = '';
		if (this.hoveredRule != null) {
			this.hoveredRule = null;
			this.drawRuleHits();
		}
	},

	serviceAction: function(action, event) {
		if ((action === 'stop' || action === 'restart') && !window.confirm(action === 'stop' ? _('Stop Mihomo now?') : _('Restart Mihomo now?')))
			return;
		const button = event.currentTarget;
		common.setBusy(button, true);
		api.write('service-action', { action: action }).then(L.bind(function() {
			common.notifySuccess(_('Mihomo service action completed.'));
			return Promise.all([ this.refreshOverview(), this.refreshRealtime() ]);
		}, this)).catch(common.notifyError).finally(function() { common.setBusy(button, false); });
	},

	fetchPublicIP: function(event) {
		const button = event && event.currentTarget ? event.currentTarget : this.root.querySelector('[data-network="fetch"]');
		const requestID = ++this.networkRequest;
		this.networkInformation = null;
		this.renderPublicIP();
		common.setBusy(button, true);
		let timeoutID;
		const timeout = new Promise(function(resolve, reject) {
			timeoutID = setTimeout(function() { reject(new Error(_('Network information request timed out'))); }, 15000);
		});
		Promise.race([ api.write('public-ip', {}), timeout ]).then(L.bind(function(data) {
			if (!data || (!data.ipip && !data.ipsb))
				throw new Error(_('The running Mihomo manager is incompatible; restart it and try again.'));
			if (requestID !== this.networkRequest)
				return;
			this.networkInformation = data;
			this.renderPublicIP();
		}, this)).catch(L.bind(function(error) {
			if (requestID !== this.networkRequest)
				return;
			this.networkInformation = { ipip: { error: error.message }, ipsb: { error: error.message } };
			this.renderPublicIP();
		}, this)).finally(function() {
			clearTimeout(timeoutID);
			common.setBusy(button, false);
		});
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
				summary.textContent = _('Checking'); summary.classList.remove('error'); summary.title = ''; address.textContent = '';
				return;
			}
			if (source.error) {
				summary.textContent = _('Query failed'); summary.classList.add('error'); summary.title = source.error; address.textContent = '';
				return;
			}
			hasAddress = hasAddress || !!source.address;
			summary.textContent = source.summary || source.family || '—'; summary.classList.remove('error'); summary.title = '';
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
			return this.refreshAggregates();
		}, this)).catch(common.notifyError);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
