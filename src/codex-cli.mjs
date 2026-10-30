import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

function executableFile(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

export function resolveCodexCli({ env = process.env, resourcesPath = '/Applications/ChatGPT.app/Contents/Resources' } = {}) {
  if (env.CODEX_REAL_CLI !== undefined) {
    if (!executableFile(env.CODEX_REAL_CLI)) throw new Error('CODEX_REAL_CLI 指向的文件不存在或不可执行，请检查配置。');
    return env.CODEX_REAL_CLI;
  }
  const candidates = [
    join(resourcesPath, 'codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    join(resourcesPath, 'codex'),
  ];
  const executable = candidates.find(executableFile);
  if (!executable) throw new Error('未找到可执行的桌面内置 CLI，请检查 ChatGPT App 安装，或设置 CODEX_REAL_CLI。');
  return executable;
}
