import { isIP } from 'node:net';

function address(value) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) throw new Error('登录来源需要单个有效 IP 地址');
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function loginSource(trustedProxyAddresses = []) {
  if (!Array.isArray(trustedProxyAddresses)) throw new Error('trustedProxyAddresses 必须为 IP 地址数组');
  const trusted = new Set(trustedProxyAddresses.map(address));
  return req => {
    const peer = address(req.socket.remoteAddress);
    // Only an explicitly trusted immediate proxy may overwrite the client identity.
    return trusted.has(peer) ? address(req.headers['x-real-ip']) : peer;
  };
}
