import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../src/http.mjs';

test('task image URLs require authentication and only serve referenced raster files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-images-'));
  const path = join(dir, 'image.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
  await writeFile(path, png);
  const server = createWebServer({ getCommand: () => ({ status: 'completed', result: { thread: { turns: [{ items: [{ type: 'userMessage', content: [{ type: 'localImage', path }] }] }] } } }) }, { password: 'test-password-image', origin: 'https://phone.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: 'https://phone.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-image' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const receipt = await (await fetch(base + '/api/commands/image-test', { headers })).json();
  const imageUrl = receipt.media[path];
  assert.match(imageUrl, /^\/api\/images\/[a-f0-9-]+$/);
  assert.equal((await fetch(base + imageUrl)).status, 401);
  const image = await fetch(base + imageUrl, { headers });
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(base + '/api/images/unknown?path=' + encodeURIComponent(path), { headers })).status, 404);
  await writeFile(path, 'not an image');
  assert.equal((await fetch(base + imageUrl, { headers })).status, 400);
});
