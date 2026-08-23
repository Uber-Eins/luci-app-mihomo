'use strict';
'require request';

function parseResponse(response) {
	let payload;
	try {
		payload = response.json();
	}
	catch (error) {
		throw new Error(_('The Mihomo manager returned an invalid response'));
	}
	if (!payload || payload.ok !== true) {
		const details = payload && payload.error ? payload.error : {};
		const error = new Error(details.message || _('Mihomo request failed'));
		error.code = details.code;
		error.details = details.details;
		error.status = response.status;
		throw error;
	}
	return payload.data;
}

function queryString(values) {
	const parts = [];
	Object.keys(values || {}).forEach(function(key) {
		if (values[key] !== null && values[key] !== undefined && values[key] !== '')
			parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(values[key]));
	});
	return parts.length ? '?' + parts.join('&') : '';
}

return L.Class.extend({
	read: function(endpoint, query) {
		const url = L.url('admin/services/mihomo/api/read/' + endpoint) + queryString(query);
		return request.get(url, { cache: false }).then(parseResponse);
	},

	write: function(endpoint, payload) {
		const body = 'token=' + encodeURIComponent(L.env.token) + '&payload=' + encodeURIComponent(JSON.stringify(payload || {}));
		return request.post(L.url('admin/services/mihomo/api/write/' + endpoint), body, {
			cache: false,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
		}).then(parseResponse);
	}
});
