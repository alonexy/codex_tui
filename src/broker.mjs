import { EventEmitter } from 'node:events';

const allowed = new Set(['thread/list', 'thread/read', 'thread/start', 'thread/resume',
  'thread/turns/list', 'thread/items/list',
  'thread/goal/get', 'thread/goal/set', 'thread/goal/clear',
  'thread/name/set', 'thread/compact/start', 'thread/archive', 'thread/unarchive',
  'turn/start', 'turn/steer', 'turn/interrupt']);
export const approvalMethods = new Set(['item/commandExecution/requestApproval',
  'item/fileChange/requestApproval', 'item/tool/requestUserInput']);

// Exactly one upstream connection. Desktop IDs never escape into Web request IDs.
export class Broker extends EventEmitter {
  constructor(send, desktop = () => {}, { ownedThreads = null, saveOwnedThread = () => {} } = {}) {
    super();
    this.send = send;
    this.desktop = desktop;
    this.next = 0;
    this.routes = new Map();
    this.commands = new Map();
    this.approvals = new Map();
    this.active = new Map();
    this.starting = new Set();
    this.threadStatus = new Map();
    this.statusCursors = new Map();
    this.archived = new Set();
    this.archiving = new Set();
    this.events = [];
    this.cursor = 0;
    this.ready = false;
    this.closed = false;
    this.ownedThreads = ownedThreads;
    this.saveOwnedThread = saveOwnedThread;
  }

  record(method, params) {
    this.events.push({ cursor: ++this.cursor, method, params });
    if (this.events.length > 1000) this.events.shift();
    this.emit('event');
  }

  fromDesktop(message) {
    if (message.method && Object.hasOwn(message, 'id')) {
      const id = `bridge:${++this.next}`;
      this.routes.set(id, { desktopId: message.id, method: message.method, threadId: message.params?.threadId, cursor: this.cursor });
      this.send({ ...message, id });
    } else if (Object.hasOwn(message, 'id')) {
      // A request may already have been answered on the phone.
      if (this.approvals.delete(message.id)) this.send(message);
    } else {
      this.send(message);
    }
  }

  receive(message) {
    if (message.method) {
      if (Object.hasOwn(message, 'id')) {
        this.approvals.set(message.id, message);
      }
      const p = message.params;
      if (message.method === 'thread/status/changed') {
        this.threadStatus.set(p.threadId, p.status); this.statusCursors.set(p.threadId, this.cursor + 1);
      }
      if (message.method === 'thread/archived') this.archived.add(p.threadId);
      if (message.method === 'thread/unarchived') this.archived.delete(p.threadId);
      if (message.method === 'turn/started') this.active.set(p.threadId, p.turn.id);
      if (message.method === 'turn/completed' && this.active.get(p.threadId) === p.turn.id) {
        this.active.delete(p.threadId);
      }
      if (message.method === 'serverRequest/resolved') this.approvals.delete(p.requestId);
      this.record(message.method, p);
      this.desktop(message);
      return;
    }
    const route = this.routes.get(message.id);
    if (!route) return;
    this.routes.delete(message.id);
    if (route.method === 'thread/archive') this.archiving.delete(route.threadId);
    if (!message.error) {
      const threads = [...(Array.isArray(message.result?.data) ? message.result.data : []), message.result?.thread];
      for (const thread of threads) {
        if (thread?.id && thread.status && (this.statusCursors.get(thread.id) ?? 0) <= route.cursor) this.threadStatus.set(thread.id, thread.status);
      }
      if (route.method === 'thread/archive') this.archived.add(route.threadId);
      if (route.method === 'thread/unarchive') this.archived.delete(route.threadId);
    }
    if (Object.hasOwn(route, 'desktopId')) {
      // The desktop may omit the separate initialized notification.
      // Only the server's successful handshake response establishes readiness.
      if (route.method === 'initialize') this.ready = !message.error;
      this.desktop({ ...message, id: route.desktopId });
      return;
    }
    if (route.method === 'turn/start') this.starting.delete(route.threadId);
    if (!message.error && route.method === 'thread/start' && this.ownedThreads) {
      this.ownedThreads.add(message.result.thread.id);
      this.saveOwnedThread(message.result.thread.id);
    }
    if (!message.error && route.method === 'thread/list' && this.ownedThreads) {
      message.result.data = message.result.data.filter(thread => this.ownedThreads.has(thread.id));
    }
    if (route.command) {
      route.command.status = message.error ? 'failed' : 'completed';
      route.command.result = message.result;
      route.command.error = message.error;
    }
    if (message.error) route.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
    else route.resolve(message.result);
  }

  rpc(method, params, command) {
    if (this.closed) return Promise.reject(new Error('App Server 已断开'));
    const id = `bridge:${++this.next}`;
    return new Promise((resolve, reject) => {
      this.routes.set(id, { resolve, reject, command, method, threadId: params?.threadId, cursor: this.cursor });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.rpc('initialize', { clientInfo: { name: 'codex_phone_bridge', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
    this.ready = true;
  }

  submit(key, method, params = {}) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new Error('缺少有效提交 ID');
    const fingerprint = JSON.stringify({ method, params });
    const old = this.commands.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('提交 ID 已被不同内容使用');
      return old;
    }
    if (!this.ready || this.closed) throw new Error('App Server 尚未连接');
    if (!allowed.has(method)) throw new Error('不支持此操作');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('参数无效');
    if (this.ownedThreads && !['thread/list', 'thread/start'].includes(method) && !this.ownedThreads.has(params.threadId)) {
      throw new Error('独立模式只能操作本服务创建的任务，不能恢复桌面任务');
    }
    if (this.commands.size >= 5000) throw new Error('本次服务提交记录已满，请重启后继续');
    if (['thread/archive', 'thread/unarchive'].includes(method) && (typeof params.threadId !== 'string' || !params.threadId)) throw new Error('缺少任务 ID');
    if (method === 'thread/archive' && (this.active.has(params.threadId) || this.starting.has(params.threadId) ||
        this.threadStatus.get(params.threadId)?.type === 'active' ||
        [...this.approvals.values()].some(request => request.params?.threadId === params.threadId))) {
      // A state change after the UI check is a known failure, never an unknown submission.
      const command = { key, fingerprint, method, status: 'failed', error: { message: '任务正在运行或等待处理，请结束后再归档' } };
      this.commands.set(key, command);
      return command;
    }
    if ((this.archived.has(params.threadId) || this.archiving.has(params.threadId)) && ['thread/resume', 'turn/start', 'turn/steer'].includes(method)) throw new Error('会话已归档或正在归档，请先确认结果并恢复');
    if (method === 'turn/start' && (this.active.has(params.threadId) || this.starting.has(params.threadId))) {
      throw new Error('任务正在运行，请使用执行中追加，或等完成后发送');
    }
    if (method === 'turn/steer' && this.active.get(params.threadId) !== params.expectedTurnId) {
      throw new Error('执行轮次已变化，请刷新后重试');
    }
    const command = { key, fingerprint, method, status: 'pending' };
    this.commands.set(key, command);
    if (method === 'turn/start') this.starting.add(params.threadId);
    if (method === 'thread/archive') this.archiving.add(params.threadId);
    // Never retry an execution request on timeout. The client polls this receipt.
    this.rpc(method, params, command).catch(error => {
      command.status = this.closed ? 'unknown' : 'failed';
      command.error = error.rpc ?? { message: error.message };
    });
    return command;
  }

  answer(id, result) {
    const request = this.approvals.get(id);
    if (!request || !approvalMethods.has(request.method)) throw new Error('请求已处理或须在桌面处理');
    if (request.method !== 'item/tool/requestUserInput') {
      if (!['accept', 'decline', 'cancel'].includes(result?.decision)) throw new Error('无效审批结果');
    } else if (!result?.answers || typeof result.answers !== 'object') throw new Error('缺少回答');
    this.approvals.delete(id);
    this.send({ id, result });
    this.record('bridge/approvalAnswered', { id });
  }

  snapshot(after = 0) {
    return {
      ready: this.ready && !this.closed, cursor: this.cursor,
      capabilities: { paginatedHistory: true, taskCommands: true, taskArchive: true },
      reset: after > this.cursor || (this.events.length > 0 && after < this.events[0].cursor - 1),
      events: this.events.filter(e => e.cursor > after),
      active: Object.fromEntries(this.active),
      approvals: [...this.approvals.values()].filter(r => approvalMethods.has(r.method)),
    };
  }

  getCommand(key) {
    return this.commands.get(key) ?? null;
  }

  close() {
    this.closed = true;
    this.ready = false;
    for (const route of this.routes.values()) route.reject?.(new Error('连接中断，执行结果未知；不要重复提交'));
    this.routes.clear();
    this.approvals.clear();
    this.record('bridge/disconnected', {});
  }
}
