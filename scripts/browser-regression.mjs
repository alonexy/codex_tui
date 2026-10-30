import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// These suites use isolated fixture servers/routes, never the running desktop.
const suites = ['mobile', 'approval-reminders', 'turn-process', 'session-names',
  'session-archive', 'file-attachments', 'model-quota', 'mcp-approval',
  'pending-ephemeral', 'image-preview', 'question-dock', 'async-questions', 'login', 'passkey'];
const requested = process.argv.slice(2);
const selected = requested.length ? requested : suites;
if (selected.some(name => !suites.includes(name))) {
  console.error(`可用隔离浏览器测试：${suites.join(', ')}`);
  process.exitCode = 1;
} else {
  const failed = [];
  for (const name of [...new Set(selected)]) {
    console.log(`浏览器回归：${name}`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL(`./${name}-smoke.mjs`, import.meta.url))], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    }).catch(error => { console.error(error.message); return 1; });
    if (code !== 0) { process.exitCode = 1; failed.push(name); }
  }
  if (failed.length) console.error(`浏览器回归未通过：${failed.join(', ')}`);
}
