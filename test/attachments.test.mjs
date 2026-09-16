import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createWebServer } from '../src/http.mjs';
import { attachmentStore } from '../src/attachments.mjs';
import { validateAttachment } from '../src/attachment-formats.mjs';
import { textExtensions } from '../public/attachment-policy.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    header.writeUInt32LE(0x02014b50); header.writeUInt32LE(bytes.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, filename, bytes); central.push(header, filename); offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function office(ext, extra = {}) {
  const [part, type] = { docx: ['word/document.xml', 'wordprocessingml.document'], xlsx: ['xl/workbook.xml', 'spreadsheetml.sheet'], pptx: ['ppt/presentation.xml', 'presentationml.presentation'] }[ext];
  return zip({ '[Content_Types].xml': `<Types><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`, '_rels/.rels': '<Relationships/>', [part]: '<document/>', ...extra });
}
function cfb(name) {
  const data = Buffer.alloc(2048); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(data); data.writeUInt16LE(0xfffe, 28); data.writeUInt16LE(9, 30); data.writeUInt32LE(1, 44); data.writeUInt32LE(1, 48); data.writeUInt32LE(0, 76);
  data.fill(255, 512, 1024); data.writeUInt32LE(0xfffffffd, 512); data.writeUInt32LE(0xfffffffe, 516);
  Buffer.from(name + '\0', 'utf16le').copy(data, 1024); data.writeUInt16LE((name.length + 1) * 2, 1088); data[1090] = 2;
  return data;
}
test('explicit formats accept text and matching Office containers and reject renamed binaries/macros', () => {
  for (const ext of textExtensions) assert.equal(validateAttachment(`example.${ext}`, Buffer.from('Hello 中文\n')), 'file');
  for (const ext of ['zip', 'exe', 'mp4', 'mp3', 'heic', 'svg', 'docm', 'xlsm', 'pptm']) assert.throws(() => validateAttachment(`file.${ext}`, png));
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('text\0binary'), Buffer.from('PK\x03\x04zip')]) assert.throws(() => validateAttachment('file.txt', bytes));
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    assert.equal(validateAttachment(`file.${ext}`, office(ext)), 'file');
    assert.throws(() => validateAttachment(`file.${ext}`, zip({ 'readme.txt': 'renamed ZIP' })));
    assert.throws(() => validateAttachment(`file.${ext}`, office(ext, { 'word/vbaProject.bin': 'macro' })));
    assert.throws(() => validateAttachment(`file.${ext}`, office(ext).subarray(0, -1)));
  }
  assert.throws(() => validateAttachment('wrong.xlsx', office('docx')));
  for (const [ext, name] of [['doc', 'WordDocument'], ['xls', 'Workbook'], ['ppt', 'PowerPoint Document']]) assert.equal(validateAttachment(`file.${ext}`, cfb(name)), 'file');
  assert.throws(() => validateAttachment('wrong.doc', cfb('Workbook')));
  assert.equal(validateAttachment('scan.pdf', Buffer.from('%PDF-1.7\nfixture\n%%EOF\n')), 'file');
  assert.throws(() => validateAttachment('wrong.pdf', Buffer.from('PDF data')));
  assert.throws(() => validateAttachment('huge.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 65)));
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-attachments-')), calls = [], commands = new Map();
  const broker = { async submit(key, method, params) { calls.push({ key, method, params }); const command = { status: 'completed', result: { content: params.input ?? [] } }; commands.set(key, command); return command; }, getCommand: key => commands.get(key) };
  const server = createWebServer(broker, { password: 'test-attachment-password', origin: 'https://phone.test', uploadDirectory: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Origin: 'https://phone.test' };
  const post = (path, data, custom = headers) => fetch(base + path, { method: 'POST', headers: { ...custom, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const login = await post('/api/login', { password: 'test-attachment-password' }); headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const upload = (name, bytes, { batch = randomUUID(), id = randomUUID(), custom = headers } = {}) => fetch(`${base}/api/attachments?batch=${batch}&id=${id}`, { method: 'POST', headers: { ...custom, 'Content-Type': 'application/octet-stream', 'X-Attachment-Name': encodeURIComponent(name) }, body: bytes });
  return { dir, calls, base, headers, post, upload };
}
test('authenticated raw uploads preserve original bytes and names, use private random storage and bounded downloads', async t => {
  const { dir, calls, base, headers, post, upload } = await fixture(t), batch = randomUUID(), id = randomUUID(), bytes = Buffer.from('<script>alert("no execution")</script>');
  assert.equal((await upload('a.txt', bytes, { custom: { Origin: headers.Origin } })).status, 401);
  assert.equal((await upload('a.txt', bytes, { custom: { ...headers, Origin: 'https://wrong.test' } })).status, 403);
  assert.equal((await upload('a.txt', bytes, { custom: { Cookie: headers.Cookie } })).status, 403);
  const response = await upload('../../原始 <script>.html', bytes, { batch, id }); assert.equal(response.status, 201);
  const file = await response.json(); assert.equal(file.input.type, 'mention'); assert.equal(file.name, '../../原始 <script>.html');
  const jsonFile = await upload('config.json', Buffer.from('{"enabled":true}')); assert.equal(jsonFile.status, 201);
  assert.equal((await readFile((await jsonFile.json()).input.path)).toString(), '{"enabled":true}', 'JSON bytes never collide with sidecar metadata');
  assert.notEqual(file.id, id); assert.equal(file.input.path, join(dir, `${file.id}.html`)); assert.deepEqual(await readFile(file.input.path), bytes);
  assert.equal((await stat(file.input.path)).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await (await upload(file.name, bytes, { batch, id })).json(), file, 'lost upload response reuses saved bytes');
  assert.equal((await fetch(base + file.url)).status, 401);
  const download = await fetch(base + file.url, { headers }); assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await fetch(base + '/api/attachments/' + randomUUID(), { headers })).status, 404);
  assert.equal((await fetch(base + '/api/attachments/%2Fetc%2Fpasswd', { headers })).status, 404);
  const command = await post('/api/commands', { key: 'file', method: 'turn/start', params: { threadId: 'one', input: [file.input] } }); assert.equal(command.status, 202);
  assert.equal(JSON.stringify(calls).includes('alert('), false);
  const record = await (await fetch(base + '/api/commands/file', { headers })).json(); assert.equal(record.files[file.input.path].url, file.url);
  for (const input of [[{ type: 'mention', path: '/etc/passwd', name: 'passwd' }], Array(11).fill(file.input)]) {
    const reject = await post('/api/commands', { key: randomUUID(), method: 'turn/start', params: { input } }); assert.equal(reject.status, 400); assert.equal((await reject.json()).submission, 'rejected');
  }
  assert.equal(calls.length, 1);
  const legacy = await (await post('/api/uploads', { image: `data:image/png;base64,${png.toString('base64')}` })).json();
  assert.equal((await post('/api/commands', { key: 'legacy', method: 'turn/start', params: { input: [legacy] } })).status, 202);
  await unlink(file.input.path); await symlink('/etc/passwd', file.input.path);
  assert.equal((await fetch(base + file.url, { headers })).status, 404);
});
test('batch counts are session isolated and removable; turn quota checks stored sizes across batches', async t => {
  const { upload, post, headers, calls } = await fixture(t), batch = randomUUID(), ids = Array.from({ length: 10 }, () => randomUUID());
  const replies = await Promise.all(ids.map(id => upload('a.txt', Buffer.from('a'), { batch, id })));
  assert.ok(replies.every(response => response.status === 201));
  assert.equal((await upload('a.txt', Buffer.from('a'), { batch })).status, 400);
  assert.equal((await post('/api/attachment-batches', { batch, keep: ids.slice(1) })).status, 200);
  assert.equal((await upload('new.txt', Buffer.from('b'), { batch })).status, 201);
  const login = await post('/api/login', { password: 'test-attachment-password' }, { Origin: headers.Origin });
  assert.equal((await upload('a.txt', Buffer.from('a'), { batch, custom: { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0] } })).status, 201);
  const big = Buffer.alloc(18 * 1024 * 1024, 65), large = [];
  for (let i = 0; i < 3; i++) large.push(await (await upload('large.txt', big)).json());
  const rejected = await post('/api/commands', { key: 'too-large', method: 'turn/steer', params: { input: large.map(value => value.input) } });
  assert.equal(rejected.status, 400); assert.equal((await rejected.json()).submission, 'rejected'); assert.equal(calls.length, 0);
});
test('in-flight uploads reserve batch bytes before reading and release failed reservations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-reserve-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = attachmentStore(dir), batch = randomUUID(), streams = [], pending = [];
  for (let i = 0; i < 2; i++) {
    const req = new PassThrough(); req.headers = { 'content-length': String(20 * 1024 * 1024) }; streams.push(req);
    pending.push(store.upload(req, 'owner', batch, randomUUID(), 'a.txt', () => true));
  }
  const third = new PassThrough(); third.headers = { 'content-length': String(20 * 1024 * 1024) };
  await assert.rejects(store.upload(third, 'owner', batch, randomUUID(), 'a.txt', () => true), /50 MiB/);
  const results = Promise.allSettled(pending); streams.forEach(req => req.end('incomplete')); assert.ok((await results).every(result => result.status === 'rejected'));
  const retry = new PassThrough(); retry.headers = { 'content-length': '2' }; retry.end('ok');
  assert.equal((await store.upload(retry, 'owner', batch, randomUUID(), 'ok.txt', () => true)).size, 2);
});
