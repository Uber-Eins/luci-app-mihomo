// SPDX-License-Identifier: Apache-2.0
'use strict';

import * as socket from 'socket';

const MANAGER_SOCKET = '/run/luci-mihomo/manager.sock';
const MAX_RESPONSE = 20 * 1024 * 1024;
const STATUS_TEXT = {
	'200': 'OK', '400': 'Bad Request', '404': 'Not Found', '405': 'Method Not Allowed',
	'409': 'Conflict', '413': 'Content Too Large', '422': 'Unprocessable Content',
	'500': 'Internal Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable', '504': 'Gateway Timeout'
};

const READ_ENDPOINTS = {
	'health': '/api/health',
	'status': '/api/status',
	'overview': '/api/overview',
	'realtime': '/api/realtime',
	'rules': '/api/rules',
	'history': '/api/history',
	'logs': '/api/logs'
};

const WRITE_ENDPOINTS = {
	'config-get': '/api/config/get',
	'config-apply': '/api/config/apply',
	'overrides-get': '/api/overrides/get',
	'overrides-draft': '/api/overrides/draft',
	'overrides-preview': '/api/overrides/preview',
	'overrides-apply': '/api/overrides/apply',
	'service-action': '/api/service/action',
	'public-ip': '/api/public-ip',
	'history-clear': '/api/history/clear'
};

function error_response(code, error_code, message) {
	http.status(code, message);
	http.prepare_content('application/json');
	http.write_json({ ok: false, error: { code: error_code, message: message } });
}

function endpoint_arg(args) {
	let value = args?.[0];
	if (type(value) == 'array')
		value = value[0];
	return value;
}

function read_query() {
	let query = http.message.env.QUERY_STRING ?? '';
	if (length(query) > 4096)
		return null;
	return length(query) ? '?' + query : '';
}

function send_all(sock, data) {
	let offset = 0;
	while (offset < length(data)) {
		let events = socket.poll(10000, [ sock, socket.POLLOUT | socket.POLLERR | socket.POLLHUP ]);
		let flags = events?.[0]?.[1] ?? 0;
		if (!(flags & socket.POLLOUT) || (flags & (socket.POLLERR | socket.POLLHUP)))
			return false;
		let sent = sock.send(substr(data, offset));
		if (!sent || sent < 0)
			return false;
		offset += sent;
	}
	return true;
}

function exchange(method, path, body) {
	let sock = socket.connect({ path: MANAGER_SOCKET }, null, null, 5000);
	if (!sock) {
		sock?.close();
		error_response(503, 'manager_unavailable', 'The luci-mihomo manager is unavailable');
		return;
	}

	body = body ?? '';
	let request = [
		`${method} ${path} HTTP/1.1`,
		'Host: luci-mihomo',
		'Accept: application/json',
		'Connection: close'
	];
	if (method == 'POST') {
		push(request, 'Content-Type: application/json');
		push(request, `Content-Length: ${length(body)}`);
	}
	push(request, '', body);

	if (!send_all(sock, join('\r\n', request))) {
		sock.close();
		error_response(502, 'manager_write_failed', 'Could not send the request to luci-mihomo');
		return;
	}

	let response = '';
	let timed_out = false;
	while (length(response) <= MAX_RESPONSE) {
		let events = socket.poll(95000, [ sock, socket.POLLIN | socket.POLLERR | socket.POLLHUP ]);
		let flags = events?.[0]?.[1] ?? 0;
		if (flags == 0) {
			timed_out = true;
			break;
		}
		if (flags & socket.POLLIN) {
			let chunk = sock.recv(32768);
			if (chunk && length(chunk))
				response += chunk;
			else
				break;
		}
		if ((flags & (socket.POLLERR | socket.POLLHUP)) && !(flags & socket.POLLIN))
			break;
	}
	sock.close();

	if (timed_out) {
		error_response(504, 'manager_timeout', 'The luci-mihomo manager did not respond in time');
		return;
	}
	if (length(response) > MAX_RESPONSE) {
		error_response(502, 'manager_response_too_large', 'The luci-mihomo response is too large');
		return;
	}

	let parts = split(response, /\r?\n\r?\n/, 2);
	let status = match(parts?.[0] ?? '', /^HTTP\/\S+\s+(\d+)/)?.[1];
	let response_body = parts?.[1] ?? '';
	if (!status) {
		error_response(502, 'invalid_manager_response', 'The luci-mihomo manager returned an invalid response');
		return;
	}

	http.status(int(status), STATUS_TEXT[int(status)] ?? 'Mihomo response');
	http.prepare_content('application/json');
	http.write(response_body);
}

function api_read(...args) {
	let endpoint = endpoint_arg(args);
	let path = READ_ENDPOINTS[endpoint];
	if (!path) {
		error_response(404, 'unknown_endpoint', 'Unknown Mihomo API endpoint');
		return;
	}
	let query = read_query();
	if (query == null) {
		error_response(414, 'query_too_large', 'Query string is too large');
		return;
	}
	exchange('GET', path + query, '');
}

function api_write(...args) {
	let endpoint = endpoint_arg(args);
	let path = WRITE_ENDPOINTS[endpoint];
	if (!path) {
		error_response(404, 'unknown_endpoint', 'Unknown Mihomo API endpoint');
		return;
	}
	let payload = http.formvalue('payload') ?? '{}';
	if (length(payload) > 4 * 1024 * 1024) {
		error_response(413, 'request_too_large', 'Request exceeds 4 MiB');
		return;
	}
	exchange('POST', path, payload);
}

return { api_read, api_write };
