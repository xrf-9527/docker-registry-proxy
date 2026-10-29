import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const nativeFetch = globalThis.fetch;
const env = { MAX_RETRIES: 0, REQUEST_TIMEOUT: 2000 };
const call = (path = '/v2/', overrides = {}, init = {}) =>
	worker.fetch(new Request('https://proxy.example:8443' + path, init), { ...env, ...overrides });
const consume = async (response) => {
	await response.arrayBuffer();
	return response;
};

let logSpy;
beforeEach(() => {
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	globalThis.fetch = nativeFetch;
	vi.restoreAllMocks();
});

describe('registry routing and authentication', () => {
	it.each(['tokenizer', 'search-engine', 'token', 'search'])('keeps %s repositories on the registry', async (name) => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		await consume(await call(`/v2/org/${name}/manifests/latest`));
		expect(globalThis.fetch.mock.calls[0][0].url).toBe(`https://registry-1.docker.io/v2/org/${name}/manifests/latest`);
	});
	it('normalizes the obsolete Docker Hub alias', async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		await consume(await call('/v2/', { PROXY_HOSTNAME: 'registry.docker.io' }));
		expect(new URL(globalThis.fetch.mock.calls[0][0].url).host).toBe('registry-1.docker.io');
	});
	it('keeps double slash paths on the configured host', async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		await consume(await call('//evil.example/v2/'));
		expect(globalThis.fetch.mock.calls[0][0].url).toBe('https://registry-1.docker.io//evil.example/v2/');
	});
	it.each([
		['registry-1.docker.io', 'https://auth.docker.io/token', 'registry.docker.io'],
		['ghcr.io', 'https://ghcr.io/token', 'ghcr.io'],
		['quay.io', 'https://quay.io/v2/auth', 'quay.io'],
	])('rewrites only the realm for %s, preserving service and scope', async (host, realm, service) => {
		const challenge = `Bearer realm="${realm}",service="${service}",scope="repository:${host}/image:pull"`;
		globalThis.fetch = vi.fn(async () => Response.json({}, { status: 401, headers: { 'www-authenticate': challenge } }));
		const response = await consume(await call('/v2/', { PROXY_HOSTNAME: host }));
		const expected = challenge.replace(realm, 'https://proxy.example:8443' + new URL(realm).pathname);
		expect(response.headers.get('www-authenticate')).toBe(expected);
	});
	it('preserves an external authentication realm', async () => {
		const challenge = 'Bearer realm="https://auth.example/token",service="registry.example"';
		globalThis.fetch = vi.fn(async () => Response.json({}, { status: 401, headers: { 'www-authenticate': challenge } }));
		const response = await consume(await call('/v2/', { PROXY_HOSTNAME: 'registry.example' }));
		expect(response.headers.get('www-authenticate')).toBe(challenge);
	});
	it('preserves credential and scope values without hostname substitution', async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		await consume(
			await call(
				'/token?scope=repository:proxy.example/image:pull&service=registry.docker.io',
				{},
				{
					headers: {
						authorization: 'Bearer proxy.example',
						cookie: 'session=private',
						'proxy-authorization': 'private',
						'cf-connecting-ip': '192.0.2.1',
					},
				},
			),
		);
		const request = globalThis.fetch.mock.calls[0][0];
		expect(request.headers.get('authorization')).toBe('Bearer proxy.example');
		expect(request.url).toContain('scope=repository:proxy.example/image:pull');
		expect(request.headers.has('cookie')).toBe(false);
		expect(request.headers.has('proxy-authorization')).toBe(false);
		expect(request.headers.has('cf-connecting-ip')).toBe(false);
		expect(request.cache).toBe('no-store');
	});
	it('removes mirror ns without discarding other query parameters', async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		await consume(await call('/v2/org/image/manifests/latest?ns=docker.io&other=a%2Bb'));
		const url = new URL(globalThis.fetch.mock.calls[0][0].url);
		expect(url.searchParams.has('ns')).toBe(false);
		expect(url.searchParams.get('other')).toBe('a+b');
	});
});

describe('transparent responses and writes', () => {
	it('removes hop-by-hop headers and tolerates empty Connection list entries', async () => {
		globalThis.fetch = vi.fn(async (request) => {
			expect(request.headers.has('x-hop')).toBe(false);
			expect(request.headers.has('connection')).toBe(false);
			expect(request.headers.has('proxy-connection')).toBe(false);
			return new Response('ok', { headers: { connection: 'x-hop,', 'x-hop': 'private' } });
		});
		const response = await consume(
			await call('/v2/', {}, { headers: { connection: 'x-hop,', 'x-hop': 'private', 'proxy-connection': 'keep-alive' } }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.has('x-hop')).toBe(false);
	});
	it('preserves text blob bytes, digest and validators', async () => {
		const text = 'source=registry-1.docker.io';
		const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (x) =>
			x.toString(16).padStart(2, '0'),
		).join('');
		globalThis.fetch = vi.fn(
			async () =>
				new Response(text, {
					headers: { 'content-type': 'text/plain', 'docker-content-digest': `sha256:${digest}`, etag: 'registry-1.docker.io' },
				}),
		);
		const response = await call(`/v2/org/image/blobs/sha256:${digest}`);
		expect(await response.text()).toBe(text);
		expect(response.headers.get('docker-content-digest')).toBe(`sha256:${digest}`);
		expect(response.headers.get('etag')).toBe('registry-1.docker.io');
	});
	it('preserves partial content and Range', async () => {
		globalThis.fetch = vi.fn(async (request) => {
			expect(request.headers.get('range')).toBe('bytes=1-3');
			return new Response('bcd', { status: 206, headers: { 'content-range': 'bytes 1-3/6' } });
		});
		const response = await call('/v2/org/image/blobs/sha256:abc', {}, { headers: { range: 'bytes=1-3' } });
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 1-3/6');
		expect(await response.text()).toBe('bcd');
	});
	it.each([204, 205, 304])('preserves bodyless status %s', async (status) => {
		globalThis.fetch = vi.fn(async () => new Response(null, { status, headers: { 'content-type': 'text/plain', etag: 'abc' } }));
		const response = await call();
		expect(response.status).toBe(status);
		expect(response.body).toBeNull();
	});
	it('preserves HEAD size without synthesizing a body', async () => {
		globalThis.fetch = vi.fn(async () => new Response(null, { headers: { 'content-length': '1234', 'content-type': 'text/plain' } }));
		const response = await call('/v2/org/image/blobs/sha256:abc', {}, { method: 'HEAD' });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('1234');
		expect(response.body).toBeNull();
	});
	it('forwards upload bodies once and rewrites Location and pagination URLs only', async () => {
		globalThis.fetch = vi.fn(async (request) => {
			expect(await request.text()).toBe('registry-1.docker.io');
			return new Response(null, {
				status: 202,
				headers: {
					location: 'https://registry-1.docker.io/v2/org/image/blobs/uploads/id?_state=a%2Bb',
					link: '<https://registry-1.docker.io/v2/org/image/tags/list?n=2>; rel="next"',
				},
			});
		});
		const response = await call('/v2/org/image/blobs/uploads/', { MAX_RETRIES: 2 }, { method: 'POST', body: 'registry-1.docker.io' });
		expect(response.status).toBe(202);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(response.headers.get('location')).toBe('https://proxy.example:8443/v2/org/image/blobs/uploads/id?_state=a%2Bb');
		expect(response.headers.get('link')).toContain('<https://proxy.example:8443/v2/org/image/tags/list?n=2>');
	});
	it('does not retry a failed write', async () => {
		globalThis.fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
		const response = await consume(await call('/v2/org/image/blobs/uploads/', { MAX_RETRIES: 2 }, { method: 'POST', body: 'data' }));
		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe('redirect and retry bounds', () => {
	it('strips auth on an origin change, including a port change', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response('redirect body', { status: 307, headers: { location: 'https://registry-1.docker.io:8443/blob' } }),
			)
			.mockResolvedValueOnce(new Response('blob'));
		await consume(await call('/v2/org/image/blobs/sha256:abc', {}, { headers: { authorization: 'Bearer secret' } }));
		expect(globalThis.fetch.mock.calls[1][0].headers.has('authorization')).toBe(false);
	});
	it.each(['http://storage.example/blob', 'file:///etc/passwd', 'https://user:pass@storage.example/blob'])(
		'rejects unsafe redirect %s',
		async (location) => {
			globalThis.fetch = vi.fn(async () => new Response('redirect body', { status: 307, headers: { location } }));
			expect((await consume(await call())).status).toBe(502);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		},
	);
	it('bounds redirect loops and cancels discarded bodies', async () => {
		const cancel = vi.fn();
		globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 307, headers: { location: '/v2/' } }));
		expect((await consume(await call())).status).toBe(502);
		expect(globalThis.fetch).toHaveBeenCalledTimes(6);
		expect(cancel).toHaveBeenCalledTimes(6);
	});
	it('honors a short Retry-After and releases the rejected body', async () => {
		const times = [];
		const cancel = vi.fn();
		globalThis.fetch = vi.fn(async () => {
			times.push(Date.now());
			return times.length === 1
				? new Response(new ReadableStream({ cancel }), { status: 429, headers: { 'retry-after': '1' } })
				: new Response('ok');
		});
		expect((await consume(await call('/v2/', { MAX_RETRIES: 1 }))).status).toBe(200);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
		expect(cancel).toHaveBeenCalledTimes(1);
	});
	it.each(['60', new Date(Date.now() + 600000).toUTCString()])(
		'returns Retry-After outside the budget (%s) without retrying',
		async (value) => {
			globalThis.fetch = vi.fn(async () => new Response('limited', { status: 429, headers: { 'retry-after': value } }));
			const response = await call('/v2/', { MAX_RETRIES: 2 });
			expect(response.status).toBe(429);
			expect(response.headers.get('retry-after')).toBe(value);
			expect(await response.text()).toBe('limited');
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		},
	);
	it('reports 504 when the response-header budget expires', async () => {
		globalThis.fetch = vi.fn(
			(request) =>
				new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })),
		);
		expect((await consume(await call('/v2/', { REQUEST_TIMEOUT: 30, MAX_RETRIES: 2 }))).status).toBe(504);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	it('stops retries when the client disconnects', async () => {
		const controller = new AbortController();
		globalThis.fetch = vi.fn(async () => new Response('limited', { status: 429, headers: { 'retry-after': '1' } }));
		const pending = call('/v2/', { MAX_RETRIES: 2 }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		expect((await consume(await pending)).status).toBe(499);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

describe('stream lifetime and backpressure', () => {
	it('hands the upstream body to the runtime without a JS wrapper', async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('layer'));
				controller.close();
			},
		});
		globalThis.fetch = vi.fn(async () => new Response(body));
		const response = await call();
		// A JS pass-through stream bills CPU per chunk and large blobs exceed the limit.
		expect(response.body).toBe(body);
		expect(await response.text()).toBe('layer');
	});
	it('allows a progressing stream longer than the response-header budget', async () => {
		let chunk = 0;
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream(
						{
							async pull(controller) {
								await new Promise((resolve) => setTimeout(resolve, 20));
								if (chunk++ === 4) controller.close();
								else controller.enqueue(new TextEncoder().encode('a'));
							},
						},
						{ highWaterMark: 0 },
					),
				),
		);
		expect(await (await call('/v2/', { REQUEST_TIMEOUT: 30 })).text()).toBe('aaaa');
	});
	it('propagates downstream cancellation', async () => {
		const cancel = vi.fn();
		globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })));
		const response = await call();
		await response.body.cancel();
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});

describe('configuration, access control and logging', () => {
	it.each([
		{ PROXY_HOSTNAME: 'host/path' },
		{ PROXY_PROTOCOL: 'ftp' },
		{ MAX_RETRIES: 6 },
		{ REQUEST_TIMEOUT: '20junk' },
		{ IP_WHITELIST_REGEX: '[' },
	])('fails closed for invalid configuration %j', async (config) => {
		globalThis.fetch = vi.fn();
		expect((await consume(await call('/v2/', config))).status).toBe(500);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it.each([{ IP_WHITELIST_REGEX: '.*' }, { IP_BLACKLIST_REGEX: 'blocked' }, { REGION_WHITELIST_REGEX: '.*' }])(
		'denies missing identity metadata with configured filters %j',
		async (config) => {
			globalThis.fetch = vi.fn();
			expect((await consume(await call('/v2/', config))).status).toBe(403);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);
	it('allows a matching whitelist but gives blacklist precedence', async () => {
		globalThis.fetch = vi.fn(async () => Response.json({}));
		const init = { headers: { 'cf-connecting-ip': '192.0.2.1' } };
		expect((await consume(await call('/v2/', { IP_WHITELIST_REGEX: '^192\\.0\\.2\\.1$' }, init))).status).toBe(200);
		expect((await consume(await call('/v2/', { IP_WHITELIST_REGEX: '.*', IP_BLACKLIST_REGEX: '^192\\.0\\.2\\.1$' }, init))).status).toBe(
			403,
		);
	});
	it('does not log credentials, query strings, headers or upstream error messages', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('secret-from-upstream-url');
		});
		await consume(
			await call(
				'/token?refresh_token=secret-query',
				{ DEBUG: true },
				{ headers: { authorization: 'Bearer secret-header', referer: 'https://example/?secret-referer' } },
			),
		);
		expect(JSON.stringify(logSpy.mock.calls)).not.toContain('secret-');
	});
	it('does not leak DEBUG state between requests', async () => {
		const run = async (debug) => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'retry-after': '0' } }))
				.mockResolvedValueOnce(new Response('ok'));
			await consume(await call('/v2/', { DEBUG: debug, MAX_RETRIES: 1 }));
		};
		await run(true);
		expect(logSpy.mock.calls.some(([line]) => JSON.parse(line).event === 'upstream_retry')).toBe(true);
		logSpy.mockClear();
		await run('false');
		expect(logSpy.mock.calls.some(([line]) => JSON.parse(line).event === 'upstream_retry')).toBe(false);
	});
});
