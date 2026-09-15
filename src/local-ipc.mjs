import http from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function localRequest(socketPath, path, data) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, agent: false, method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode !== 200) throw new Error(value.error ?? '本机接口错误');
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('本机连接超时；请查询提交回执，不要重发指令')));
    request.on('error', reject);
    request.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

export async function listenLocal(socketPath, handle) {
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('本机 socket 目录必须归当前用户所有，权限为 700');
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new Error('socket 路径被其他文件占用');
    try { await localRequest(socketPath, '/status'); throw new Error('本机服务已运行'); }
    catch (error) {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) throw new Error('请求过大');
      }
      const result = await handle(req.method, req.url, raw ? JSON.parse(raw) : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result ?? null));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return server;
}
