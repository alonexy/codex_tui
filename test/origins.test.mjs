import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer } from '../src/http.mjs';

test('explicit LAN and public origins both work; different ports and absent origins are rejected', async t => {
  // Illustrative LAN address and documentation-only public address, never a live deployment.
  const origin = 'http://192.168.1.100:8787', external = 'http://203.0.113.10:18080';
  const options = { password: 'origin-test-password', origin, allowLanHttp: true, additionalOrigins: [external] };
  assert.throws(() => createWebServer({}, options), /HTTPS/);
  const server = createWebServer({ snapshot: () => ({ ready: true }) }, { ...options, allowHttpOrigins: [external] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const allowed of [origin, external]) {
    assert.equal((await fetch(base + '/login.js', { headers: { Origin: allowed } })).status, 200);
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: allowed, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: options.password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/state', { headers: { Origin: allowed, Cookie: cookie } })).status, 200);
  }
  for (const denied of ['http://203.0.113.10:18081', 'http://evil.example', 'null', '']) {
    const headers = { 'Content-Type': 'application/json', ...(denied ? { Origin: denied } : {}) };
    assert.equal((await fetch(base + '/api/login', { method: 'POST', headers, body: '{}' })).status, 403);
  }
});
