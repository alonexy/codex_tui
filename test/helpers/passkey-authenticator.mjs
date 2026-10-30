import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const hash = value => createHash('sha256').update(value).digest();
const base64 = value => Buffer.from(value).toString('base64url');
const counterBytes = counter => { const value = Buffer.alloc(4); value.writeUInt32BE(counter); return value; };

// Test software authenticator: real EC keys, COSE encoding and signed assertions.
// Production verification always runs through the installed SimpleWebAuthn library.
export function softwareAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }), id = randomBytes(32);
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  function clientData(options, origin, type, changes) {
    return Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false, ...changes }));
  }
  function response(data) { return { id: base64(id), rawId: base64(id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {}, response: data }; }
  return {
    id: base64(id),
    registration(options, origin, { client = {}, rpID = options.rp.id, flags = 0x45, counter = 0 } = {}) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const authData = Buffer.concat([hash(rpID), Buffer.from([flags]), counterBytes(counter), Buffer.alloc(16), length, id, cose]);
      return response({ clientDataJSON: base64(clientData(options, origin, 'webauthn.create', client)), attestationObject: base64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] });
    },
    authentication(options, origin, userHandle, { client = {}, rpID = options.rpId, flags = 0x05, counter = 1, invalidSignature = false } = {}) {
      const json = clientData(options, origin, 'webauthn.get', client);
      const authData = Buffer.concat([hash(rpID), Buffer.from([flags]), counterBytes(counter)]);
      const signature = sign('sha256', Buffer.concat([authData, hash(json)]), privateKey);
      if (invalidSignature) signature[signature.length - 1] ^= 1;
      return response({ clientDataJSON: base64(json), authenticatorData: base64(authData), signature: base64(signature), userHandle });
    },
  };
}

export function cookiePair(value) { return value.split(';')[0]; }
export function withCookies(req, ...values) {
  const cookies = new Map((req.headers.cookie ?? '').split(';').filter(Boolean).map(value => value.trim().split('=')));
  for (const value of values) { const [key, data] = cookiePair(value).split('='); cookies.set(key, data); }
  return { headers: { ...req.headers, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } };
}
