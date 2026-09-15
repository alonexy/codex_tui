import test from 'node:test';
import assert from 'node:assert/strict';
import { loginSource } from '../src/login-source.mjs';

const request = (peer, ip) => ({ socket: { remoteAddress: peer }, headers: { 'x-real-ip': ip, 'x-forwarded-for': '192.0.2.9' } });
test('source identity is canonical and forwarding trust is explicit', () => {
  assert.equal(loginSource()(request('::ffff:192.0.2.1', '192.0.2.9')), '192.0.2.1');
  const source = loginSource(['::ffff:127.0.0.1']);
  assert.equal(source(request('127.0.0.1', '2001:0DB8:0:0:0:0:0:1')), '2001:db8::1');
  assert.equal(source(request('192.0.2.2', '192.0.2.9')), '192.0.2.2');
  assert.throws(() => source(request('127.0.0.1', ['192.0.2.1', '192.0.2.2'])));
  assert.throws(() => source(request('127.0.0.1', 'fe80::1%en0')));
  assert.throws(() => loginSource(['localhost']));
  assert.throws(() => loginSource('*'));
});
