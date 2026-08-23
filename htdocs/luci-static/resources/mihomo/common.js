'use strict';
'require ui';

function ensureStyle() {
	if (document.getElementById('mihomo-panel-style'))
		return;
	const link = document.createElement('link');
	link.id = 'mihomo-panel-style';
	link.rel = 'stylesheet';
	link.href = L.resource('mihomo/style.css');
	document.head.appendChild(link);
}

function formatBytes(value, speed) {
	value = Number(value) || 0;
	const units = [ _('B'), _('KiB'), _('MiB'), _('GiB'), _('TiB') ];
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
	return value.toFixed(digits) + ' ' + units[unit] + (speed ? _('/s') : '');
}

function formatTime(value) {
	if (!value)
		return '—';
	const date = new Date(value);
	return isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function errorMessage(error) {
	let message = error && error.message ? error.message : _('Unknown error');
	if (error && error.details) {
		if (typeof error.details === 'string')
			message += '\n\n' + error.details;
		else {
			try { message += '\n\n' + JSON.stringify(error.details, null, 2); }
			catch (ignored) {}
		}
	}
	return message;
}

function notifyError(error) {
	ui.addNotification(null, E('pre', { 'class': 'mihomo-notice-text' }, [ errorMessage(error) ]), 'error');
}

function notifySuccess(message) {
	ui.addNotification(null, E('p', {}, [ message ]), 'info');
}

function setBusy(button, busy) {
	if (!button)
		return;
	button.disabled = !!busy;
	button.classList.toggle('spinning', !!busy);
}

function text(node, value) {
	if (node)
		node.textContent = value == null ? '—' : String(value);
}

return L.Class.extend({
	ensureStyle: ensureStyle,
	formatBytes: formatBytes,
	formatTime: formatTime,
	errorMessage: errorMessage,
	notifyError: notifyError,
	notifySuccess: notifySuccess,
	setBusy: setBusy,
	text: text
});
