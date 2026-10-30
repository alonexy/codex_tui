import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('public/vendor', { recursive: true });
await build({ stdin: { contents: "export { startRegistration, startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';", resolveDir: process.cwd() }, bundle: true, minify: true, format: 'esm', target: ['es2020'], outfile: 'public/vendor/webauthn-browser.js', legalComments: 'eof' });
await copyFile('node_modules/@simplewebauthn/browser/LICENSE.md', 'public/vendor/webauthn-LICENSE.txt');
console.log('Bundled local SimpleWebAuthn browser module and license.');
