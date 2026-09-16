import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { checkAttachment, formatBytes, maxAttachments, maxTotalBytes } from '../public/attachment-policy.js';

function mediaComposer() {
  const elements = new Map(), readers = [];
  const element = () => ({ children: [], replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, setAttribute() {}, addEventListener() {} });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({
    crypto: webcrypto, checkAttachment, formatBytes, maxAttachments, maxTotalBytes,
    document: { getElementById: get, createElement: element }, window: { addEventListener() {} },
    FileReader: class { readAsDataURL(file) { this.result = `data:image/png;base64,${file.name}`; readers.push(this); } },
  });
  vm.runInContext(readFileSync(new URL('../public/composer-media.js', import.meta.url), 'utf8').replace(/^import .*\n/, '').replace('export function', 'function'), context);
  vm.runInContext("let currentThread = 'one'; const media = composerMedia({ getThread: () => currentThread, busy: () => false, api: async () => ({}), changed() {}, error(e) { throw e; } });", context);
  const run = code => vm.runInContext(code, context);
  const begin = name => { get('image-files').files = [{ name, type: 'image/png', size: 1 }]; get('image-files').onchange(); };
  const finish = async () => { readers.shift().onload(); await new Promise(resolve => setImmediate(resolve)); };
  const add = async name => { begin(name); await finish(); };
  const names = () => get('image-previews').children.map(card => card.children[0].alt);
  return { run, begin, finish, add, names };
}

test('acknowledging one submission preserves later images in both the original and current tasks', async () => {
  const media = mediaComposer();
  await media.add('sent.png');
  media.run('const submitted = media.capture()');
  await media.add('later.png');
  media.run("currentThread = 'two'; media.render()");
  await media.add('other-task.png');
  media.run('media.clear(submitted)');
  assert.deepEqual(media.names(), ['other-task.png']);
  media.run("currentThread = 'one'; media.render()");
  assert.deepEqual(media.names(), ['later.png']);
});

test('a late text-only receipt does not remove a newly added image', async () => {
  const media = mediaComposer();
  media.run('const submitted = media.capture()');
  await media.add('new.png');
  media.run('media.clear(submitted)');
  assert.deepEqual(media.names(), ['new.png']);
});

test('reading a new file while a receipt arrives does not restore already acknowledged images', async () => {
  const media = mediaComposer();
  await media.add('sent.png');
  media.run('const submitted = media.capture()');
  media.begin('reading.png');
  media.run('media.clear(submitted)');
  await media.finish();
  assert.deepEqual(media.names(), ['reading.png']);
});
