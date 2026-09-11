import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Anonymous, read-only Docker Hub pull with byte-level digest verification.
// Tokens stay in memory and are never printed or persisted.
const base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
const repository = 'library/busybox';
const accept = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
let token;
async function get(path, options = {}) {
	const headers = new Headers(options.headers);
	headers.set('accept', accept);
	if (token) headers.set('authorization', `Bearer ${token}`);
	const response = await fetch(new URL(path, base), { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
	return response;
}
const challengeResponse = await get(`/v2/${repository}/manifests/latest`);
assert.equal(challengeResponse.status, 401, 'expected registry authentication challenge');
const challenge = challengeResponse.headers.get('www-authenticate');
await challengeResponse.body?.cancel();
const parameters = Object.fromEntries([...challenge.matchAll(/(realm|service|scope)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
const authUrl = new URL(parameters.realm);
assert.equal(authUrl.origin, base.origin, 'authentication must pass through the proxy');
assert.equal(parameters.service, 'registry.docker.io', 'upstream service identity must be preserved');
authUrl.searchParams.set('service', parameters.service);
authUrl.searchParams.set('scope', parameters.scope);
const auth = await fetch(authUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(auth.status, 200, 'token exchange failed');
const credentials = await auth.json();
token = credentials.token || credentials.access_token;
assert.ok(token, 'missing token');
console.log('PASS authentication through proxy');

async function manifest(reference) {
	const response = await get(`/v2/${repository}/manifests/${reference}`);
	assert.equal(response.status, 200, 'manifest fetch failed');
	const bytes = new Uint8Array(await response.arrayBuffer());
	const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
	assert.equal(response.headers.get('docker-content-digest'), digest, 'manifest digest mismatch');
	if (reference.startsWith('sha256:')) assert.equal(digest, reference);
	return JSON.parse(new TextDecoder().decode(bytes));
}
const index = await manifest('latest');
const platform = index.manifests.find((item) => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64');
assert.ok(platform, 'linux/amd64 manifest missing');
const image = await manifest(platform.digest);
console.log('PASS index and platform manifest digests');
for (const descriptor of [image.config, ...image.layers]) {
	const path = `/v2/${repository}/blobs/${descriptor.digest}`;
	const head = await get(path, { method: 'HEAD' });
	assert.equal(head.status, 200, 'blob HEAD failed');
	assert.equal(Number(head.headers.get('content-length')), descriptor.size, 'blob HEAD size mismatch');
	const response = await get(path);
	assert.equal(response.status, 200, 'blob fetch failed');
	const hash = createHash('sha256');
	let bytes = 0;
	for await (const chunk of response.body) {
		hash.update(chunk);
		bytes += chunk.byteLength;
	}
	assert.equal(bytes, descriptor.size, 'blob size mismatch');
	assert.equal('sha256:' + hash.digest('hex'), descriptor.digest, 'blob digest mismatch');
	console.log(`PASS blob HEAD, size and digest (${bytes} bytes)`);
}
const range = await get(`/v2/${repository}/blobs/${image.layers[0].digest}`, { headers: { range: 'bytes=0-31' } });
assert.equal(range.status, 206, 'upstream Range support required for this smoke test');
assert.equal(range.headers.get('content-range'), `bytes 0-31/${image.layers[0].size}`);
assert.equal((await range.arrayBuffer()).byteLength, 32);
console.log('PASS Range / 206');
console.log(`Verified anonymous busybox pull via ${base.origin}`);
