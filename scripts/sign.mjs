// Independent signer: Node built-ins only. Never imports or executes application code.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'misosiruda/bongo-cat-chat';
export const PUBLIC_KEY = 'Wu15J5pBex0qY1+yjzg6dr1CYAXfbakomfHzkNNC9b0=';
export const ARCHIVE = 'bongo-cat-chat-windows-x64.zip';
export const DOMAIN = Buffer.from('BONGO_CAT_CHAT_RELEASE_V1\n');
const publicObject = value => createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value, 'base64')]), format: 'der', type: 'spki'});
export const canonical = value => Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]))));
export function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.dev(0|[1-9][0-9]*))?$/.test(value) || value.length > 60) throw Error('Invalid version');
  return value;
}
export function newer(candidate, current) {
  const parts = v => version(v).split(/\.|dev/).filter(Boolean).map(BigInt);
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  if (a.length !== b.length) return a.length < b.length;
  return a.length === 4 && a[3] > b[3];
}
export function commit(value) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw Error('Full lowercase source SHA required');
  return value;
}
export function manifest(raw, expectedVersion) {
  if (raw.length > 16384) throw Error('Manifest too large');
  const m = JSON.parse(raw);
  const keys = ['schema', 'repository', 'version', 'platform', 'archive', 'size', 'sha256', 'data_schema', 'bootstrap_schema'];
  if (!m || typeof m !== 'object' || Object.keys(m).sort().join() !== keys.sort().join() || !canonical(m).equals(raw)) throw Error('Noncanonical manifest');
  if (m.schema !== 1 || m.data_schema !== 1 || m.bootstrap_schema !== 1 || m.repository !== REPOSITORY || m.platform !== 'windows-x64' || m.archive !== ARCHIVE || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > 1073741824 || !/^[a-f0-9]{64}$/.test(m.sha256) || version(m.version) !== expectedVersion) throw Error('Unsupported manifest');
  return m;
}
export function privateObject(seed, publicKey = PUBLIC_KEY) {
  if (typeof seed !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(seed)) throw Error('Invalid signing secret');
  const bytes = Buffer.from(seed, 'base64');
  const key = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]), type: 'pkcs8', format: 'der'});
  bytes.fill(0);
  if (!createPublicKey(key).export({type: 'spki', format: 'der'}).equals(publicObject(publicKey).export({type: 'spki', format: 'der'}))) throw Error('Signing key does not match pinned public key');
  return key;
}
export async function fileDigest(path, max = 2147483648) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw Error('Unsafe or oversized file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {size: s.size, sha256: hash.digest('hex')};
}
export function assetNames(v) {
  version(v);
  return [ARCHIVE, `BongoCatChat-${v}-windows-x64-Setup.exe`, `BongoCatChat-${v}-corresponding-sources.zip`, 'sources.lock.json', 'SOURCES.md', 'THIRD-PARTY-NOTICES.txt', 'update-manifest.json'];
}
export async function inspect(directory, expectedVersion) {
  const expected = assetNames(expectedVersion).sort();
  if ((await readdir(directory)).sort().join() !== expected.join()) throw Error('Unexpected or missing candidate assets');
  const files = {};
  for (const name of expected) files[name] = await fileDigest(join(directory, name), name === 'update-manifest.json' ? 16384 : 2147483648);
  const raw = await readFile(join(directory, 'update-manifest.json'));
  const m = manifest(raw, expectedVersion);
  if (m.size !== files[ARCHIVE].size || m.sha256 !== files[ARCHIVE].sha256) throw Error('Archive hash mismatch');
  return {raw, files};
}
export async function approve(directory, metadata, seed, publicKey = PUBLIC_KEY) {
  commit(metadata.source_sha); version(metadata.version); commit(metadata.signer_sha);
  if (!/^[1-9][0-9]*$/.test(metadata.run_id) || !/^[1-9][0-9]*$/.test(metadata.run_attempt)) throw Error('Invalid workflow identity');
  const {raw, files} = await inspect(directory, metadata.version);
  const key = privateObject(seed, publicKey);
  const signature = sign(null, raw, key);
  if (!verify(null, raw, publicObject(publicKey), signature)) throw Error('Signature verification failed');
  await writeFile(join(directory, 'update-manifest.sig'), signature, {flag: 'wx'});
  files['update-manifest.sig'] = await fileDigest(join(directory, 'update-manifest.sig'));
  const receipt = canonical({schema: 1, repository: REPOSITORY, version: metadata.version, source_sha: metadata.source_sha, signer_sha: metadata.signer_sha, run_id: metadata.run_id, run_attempt: metadata.run_attempt, windows_authenticode: false, files});
  await writeFile(join(directory, 'release-approval.json'), receipt, {flag: 'wx'});
  await writeFile(join(directory, 'release-approval.sig'), sign(null, Buffer.concat([DOMAIN, receipt]), key), {flag: 'wx'});
  const names = (await readdir(directory)).sort();
  const sums = [];
  for (const name of names) sums.push(`${(await fileDigest(join(directory, name))).sha256}  ${name}`);
  await writeFile(join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n', {flag: 'wx'});
  return JSON.parse(receipt);
}
export async function verifyApproved(directory, expected, publicKey = PUBLIC_KEY) {
  version(expected.version); commit(expected.source_sha); commit(expected.signer_sha);
  const allowed = [...assetNames(expected.version), 'update-manifest.sig', 'release-approval.json', 'release-approval.sig', 'SHA256SUMS.txt'].sort();
  if ((await readdir(directory)).sort().join() !== allowed.join()) throw Error('Unexpected signed assets');
  // Bound metadata and signature reads before allocating buffers.
  for (const name of ['release-approval.json', 'update-manifest.json', 'SHA256SUMS.txt']) await fileDigest(join(directory, name), 16384);
  for (const name of ['release-approval.sig', 'update-manifest.sig']) { if ((await fileDigest(join(directory, name), 64)).size !== 64) throw Error('Invalid signature length'); }
  const raw = await readFile(join(directory, 'release-approval.json'));
  const signature = await readFile(join(directory, 'release-approval.sig'));
  if (!verify(null, Buffer.concat([DOMAIN, raw]), publicObject(publicKey), signature)) throw Error('Invalid approval signature');
  const receipt = JSON.parse(raw);
  if (!canonical(receipt).equals(raw) || receipt.schema !== 1 || receipt.repository !== REPOSITORY || receipt.windows_authenticode !== false || receipt.version !== expected.version || receipt.source_sha !== expected.source_sha || receipt.signer_sha !== expected.signer_sha || receipt.run_id !== expected.run_id || receipt.run_attempt !== expected.run_attempt) throw Error('Approval identity mismatch');
  if (Object.keys(receipt.files).sort().join() !== [...assetNames(expected.version), 'update-manifest.sig'].sort().join()) throw Error('Invalid approval files');
  for (const [name, wanted] of Object.entries(receipt.files)) {
    const actual = await fileDigest(join(directory, name));
    if (actual.sha256 !== wanted.sha256 || actual.size !== wanted.size) throw Error('Approved file changed');
  }
  const mraw = await readFile(join(directory, 'update-manifest.json'));
  const m = manifest(mraw, expected.version);
  if (!verify(null, mraw, publicObject(publicKey), await readFile(join(directory, 'update-manifest.sig'))) || m.sha256 !== receipt.files[ARCHIVE].sha256 || m.size !== receipt.files[ARCHIVE].size) throw Error('Invalid update signature or hash');
  const sums = [];
  for (const name of allowed.filter(n => n !== 'SHA256SUMS.txt')) sums.push(`${(await fileDigest(join(directory, name))).sha256}  ${name}`);
  if ((await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')) !== sums.join('\n') + '\n') throw Error('Invalid checksums');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const metadata = {version: process.env.RELEASE_VERSION, source_sha: process.env.SOURCE_SHA, signer_sha: process.env.SIGNER_SHA, run_id: process.env.RELEASE_RUN_ID, run_attempt: process.env.RELEASE_RUN_ATTEMPT};
  if (process.argv[2] === 'sign') {
    const candidate = await inspect(process.argv[3], metadata.version);
    if (createHash('sha256').update(JSON.stringify(candidate.files)).digest('hex') !== process.env.APPROVED_FILES_SHA256) throw Error('Candidate changed after approval summary');
    await approve(process.argv[3], metadata, process.env.UPDATE_SIGNING_KEY);
    delete process.env.UPDATE_SIGNING_KEY;
    console.log('Pinned-key signatures and asset hashes verified.');
  } else if (process.argv[2] === 'verify') {
    await verifyApproved(process.argv[3], metadata);
    console.log('Approved release identity and all asset hashes verified.');
  } else throw Error('Use sign or verify');
}
