import { WorkerLogger } from './logger.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const READ_METHODS = new Set(['GET', 'HEAD']);
const HOP_HEADERS = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
];

class ProxyError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.status = status;
	}
}

function integer(value, fallback, max) {
	const number = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new ProxyError('Invalid timeout configuration', 500);
	return number;
}

function configuration(env) {
	const hostname = env.PROXY_HOSTNAME || 'registry-1.docker.io';
	const protocol = env.PROXY_PROTOCOL || 'https';
	let upstream;
	try {
		upstream = new URL(`${protocol}://${hostname}`);
	} catch {
		throw new ProxyError('Invalid upstream configuration', 500);
	}
	if (
		!['https:', 'http:'].includes(upstream.protocol) ||
		upstream.username ||
		upstream.password ||
		upstream.pathname !== '/' ||
		upstream.search ||
		upstream.hash
	) {
		throw new ProxyError('Invalid upstream configuration', 500);
	}
	// The legacy alias no longer serves the Registry API.
	if (upstream.hostname === 'registry.docker.io') upstream.hostname = 'registry-1.docker.io';
	const maxRetries = env.MAX_RETRIES === undefined ? 2 : Number(env.MAX_RETRIES);
	if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new ProxyError('MAX_RETRIES must be between 0 and 5', 500);
	const filters = {};
	for (const key of [
		'PATHNAME_REGEX',
		'UA_WHITELIST_REGEX',
		'UA_BLACKLIST_REGEX',
		'IP_WHITELIST_REGEX',
		'IP_BLACKLIST_REGEX',
		'REGION_WHITELIST_REGEX',
		'REGION_BLACKLIST_REGEX',
	]) {
		if (env[key]) {
			try {
				filters[key] = new RegExp(env[key]);
			} catch {
				throw new ProxyError(`Invalid ${key}`, 500);
			}
		}
	}
	return {
		upstream,
		filters,
		maxRetries,
		timeout: integer(env.REQUEST_TIMEOUT, 120000, 300000),
	};
}

function allowed(request, url, filters) {
	if (filters.PATHNAME_REGEX && !filters.PATHNAME_REGEX.test(url.pathname)) return false;
	const attributes = {
		UA: request.headers.get('user-agent')?.toLowerCase(),
		IP: request.headers.get('cf-connecting-ip'),
		REGION: request.cf?.country || request.headers.get('cf-ipcountry'),
	};
	for (const [prefix, value] of Object.entries(attributes)) {
		const whitelist = filters[`${prefix}_WHITELIST_REGEX`];
		const blacklist = filters[`${prefix}_BLACKLIST_REGEX`];
		// A configured filter must not silently allow missing identity metadata.
		if ((whitelist || blacklist) && !value) return false;
		if (whitelist && !whitelist.test(value)) return false;
		if (blacklist?.test(value)) return false;
	}
	return true;
}

function cleanHeaders(source) {
	const headers = new Headers(source);
	const connectionHeaders = headers.get('connection')?.split(',') || [];
	for (const key of [...HOP_HEADERS, ...connectionHeaders]) {
		if (key.trim()) headers.delete(key.trim());
	}
	return headers;
}

function upstreamHeaders(request) {
	const headers = cleanHeaders(request.headers);
	for (const key of [...headers.keys()]) {
		if (
			key === 'host' ||
			key === 'cookie' ||
			key === 'forwarded' ||
			key === 'referer' ||
			key.startsWith('cf-') ||
			key.startsWith('x-forwarded-')
		)
			headers.delete(key);
	}
	return headers;
}

function responseHeaders(response, upstream, publicUrl, hub) {
	const headers = cleanHeaders(response.headers);
	const rewrite = (value, auth = false) => {
		let url;
		try {
			url = new URL(value);
		} catch {
			return value;
		}
		const hubAuth = auth && hub && url.origin === 'https://auth.docker.io' && url.pathname === '/token';
		if (url.origin !== upstream.origin && !hubAuth) return value;
		url.protocol = publicUrl.protocol;
		url.host = publicUrl.host;
		return url.toString();
	};
	const challenge = headers.get('www-authenticate');
	if (challenge)
		headers.set(
			'www-authenticate',
			challenge.replace(/(\brealm\s*=\s*")([^"]+)(")/gi, (_, start, realm, end) => start + rewrite(realm, true) + end),
		);
	const location = headers.get('location');
	if (location) headers.set('location', rewrite(location));
	const link = headers.get('link');
	if (link)
		headers.set(
			'link',
			link.replace(/<([^>]+)>/g, (_, url) => `<${rewrite(url)}>`),
		);
	// This is a forwarding proxy, not a shared cache for authenticated images.
	headers.set('cache-control', 'no-store');
	return headers;
}

function retryDelay(response, attempt) {
	const value = response?.headers.get('retry-after');
	if (value !== null && value !== undefined) {
		if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	return Math.min(2000, 200 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}

async function discard(response) {
	if (response?.body) await response.body.cancel();
}

async function fetchUpstream(request, target, config, logger) {
	const headers = upstreamHeaders(request);
	const controller = new AbortController();
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const deadline = Date.now() + config.timeout;
	const timer = setTimeout(() => controller.abort(new ProxyError('Upstream response timeout', 504)), config.timeout);
	const canRetry = READ_METHODS.has(request.method);
	try {
		for (let attempt = 0; ; attempt++) {
			let response;
			try {
				let url = new URL(target);
				const hopHeaders = new Headers(headers);
				for (let hops = 0; ; hops++) {
					signal.throwIfAborted();
					response = await fetch(
						new Request(url, {
							method: request.method,
							headers: hopHeaders,
							redirect: 'manual',
							cache: 'no-store',
							signal,
							body: canRetry ? undefined : request.body,
						}),
					);
					if (!canRetry || !REDIRECTS.has(response.status)) break;
					const location = response.headers.get('location');
					if (!location) break;
					await discard(response);
					response = undefined;
					if (hops >= 5) throw new ProxyError('Too many upstream redirects');
					let next;
					try {
						next = new URL(location, url);
					} catch {
						throw new ProxyError('Invalid upstream redirect');
					}
					if (
						!['http:', 'https:'].includes(next.protocol) ||
						next.username ||
						next.password ||
						(url.protocol === 'https:' && next.protocol !== 'https:')
					)
						throw new ProxyError('Unsafe upstream redirect');
					if (next.origin !== url.origin) hopHeaders.delete('authorization');
					url = next;
				}
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				if (error instanceof ProxyError || !canRetry || attempt >= config.maxRetries) throw error;
			}
			if (response && (!canRetry || !RETRYABLE.has(response.status) || attempt >= config.maxRetries)) return response;
			const delay = retryDelay(response, attempt);
			// A long Retry-After is returned to the caller, never shortened to fit our budget.
			if (Date.now() + delay >= deadline) {
				if (response) return response;
				throw new ProxyError('Upstream response timeout', 504);
			}
			await discard(response);
			logger.debug('upstream_retry', { attempt: attempt + 1, delayMs: delay });
			await sleep(delay, signal);
		}
	} finally {
		clearTimeout(timer);
	}
}

export default {
	async fetch(request, env) {
		const logger = new WorkerLogger(request, env.DEBUG === true || env.DEBUG === 'true');
		try {
			const config = configuration(env);
			const publicUrl = new URL(request.url);
			if (!allowed(request, publicUrl, config.filters)) {
				logger.log('access_denied', { status: 403 });
				return Response.json(
					{ errors: [{ code: 'DENIED', message: 'Access denied' }] },
					{ status: 403, headers: { 'cache-control': 'no-store' } },
				);
			}
			const hub = config.upstream.hostname === 'registry-1.docker.io';
			const target = new URL(config.upstream);
			target.pathname = publicUrl.pathname;
			target.search = publicUrl.search;
			if (target.origin === publicUrl.origin) throw new ProxyError('Proxy cannot target itself', 500);
			if (hub && publicUrl.pathname === '/token') {
				target.protocol = 'https:';
				target.host = 'auth.docker.io';
			}
			if (target.pathname.startsWith('/v2/') && target.searchParams.has('ns')) target.searchParams.delete('ns');
			const response = await fetchUpstream(request, target, config, logger);
			const headers = responseHeaders(response, config.upstream, publicUrl, hub);
			logger.log('response_headers', { status: response.status, upstream: target.host });
			if (request.method === 'HEAD' || [204, 205, 304].includes(response.status)) {
				await discard(response);
				return new Response(null, { status: response.status, headers });
			}
			// Hand the upstream body to the runtime untouched so it is piped natively.
			// Wrapping it in a JS stream bills CPU per chunk, and large layers hit the
			// CPU limit mid-transfer; the runtime still cancels upstream on disconnect.
			return new Response(response.body, { status: response.status, headers });
		} catch (error) {
			const status = request.signal.aborted ? 499 : error instanceof ProxyError ? error.status : 502;
			logger.log('request_error', { status });
			return Response.json(
				{
					errors: [
						{
							code: 'UNKNOWN',
							message:
								status === 500
									? 'Invalid proxy configuration'
									: status === 504
										? 'Upstream timeout'
										: status === 499
											? 'Client disconnected'
											: 'Upstream request failed',
						},
					],
				},
				{ status, headers: { 'cache-control': 'no-store' } },
			);
		}
	},
};
