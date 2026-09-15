import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReady, waitForExit } from '../scripts/start-desktop.mjs';

test('a desktop process exiting successfully without a bridge is a launch failure', async () => {
  await assert.rejects(waitForReady({ probe: async () => false, exited: () => 0, pause: async () => {}, attempts: 2 }), /现有实例|提前退出/);
});

test('launch is ready only after the authenticated shared bridge is ready', async () => {
  let count = 0;
  await waitForReady({ probe: async () => ++count === 3, exited: () => null, pause: async () => {}, attempts: 3 });
  assert.equal(count, 3);
});

test('an existing desktop is waited out, not killed or relaunched over', async () => {
  let count = 0;
  await waitForExit({ pids: async () => ++count < 3 ? [90586] : [], pause: async () => {}, attempts: 3 });
  assert.equal(count, 3);
  await assert.rejects(waitForExit({ pids: async () => [90586], pause: async () => {}, attempts: 2 }), /仍未退出/);
});
