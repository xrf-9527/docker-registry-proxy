import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';

function createEnv(overrides = {}) {
  return {
    PROXY_HOSTNAME: 'registry-1.docker.io',
    PROXY_PROTOCOL: 'https',
    DEBUG: false,
    MAX_RETRIES: 2,
    REQUEST_TIMEOUT: 2000,
    ...overrides,
  };
}

describe('Docker registry proxy worker', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns 500 response when upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const request = new Request('https://proxy.example/v2/library/busybox/manifests/latest');
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, createEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });

  it('routes /token to Docker Hub auth service when proxying Docker Hub', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    globalThis.fetch = fetchMock;
    const request = new Request('https://proxy.example/token?service=registry.docker.io');
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, createEnv({ PROXY_HOSTNAME: 'registry-1.docker.io' }), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetchMock.mock.calls[0][0];
    expect(new URL(forwardedRequest.url).hostname).toBe('auth.docker.io');
  });

  it('does not force /token to auth.docker.io when proxying non-Hub registries', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    globalThis.fetch = fetchMock;
    const request = new Request('https://proxy.example/token?service=ghcr.io');
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, createEnv({ PROXY_HOSTNAME: 'ghcr.io' }), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetchMock.mock.calls[0][0];
    expect(new URL(forwardedRequest.url).hostname).toBe('ghcr.io');
  });

  it('retries upstream request on HTTP 429 and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    globalThis.fetch = fetchMock;
    const request = new Request('https://proxy.example/v2/library/busybox/manifests/latest');
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, createEnv({ MAX_RETRIES: 3 }), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
