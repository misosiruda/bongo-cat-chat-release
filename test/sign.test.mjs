import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, verify as edVerify, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approve, verifyApproved, canonical, manifest, privateObject, version, newer, assetNames, REPOSITORY, ARCHIVE, DOMAIN, PUBLIC_KEY } from '../scripts/sign.mjs';
import { createPublicKey } from 'node:crypto';

test('Existing dev11 public manifest verifies with the unchanged client key', async () => {
  const raw = await readFile(new URL('../fixtures/dev11-manifest.json', import.meta.url));
  const sig = Buffer.from((await readFile(new URL('../fixtures/dev11-signature.txt', import.meta.url), 'utf8')).trim(), 'base64');
  const key = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY, 'base64')]), format: 'der', type: 'spki'});
  assert.equal(manifest(raw, '0.1.0.dev11').version, '0.1.0.dev11');
  assert.ok(edVerify(null, raw, key, sig));
});

function keys() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  return {privateKey, publicKey, seed: privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32).toString('base64'), pinned: publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64')};
}
const metadata = {version: '0.1.0.dev12', source_sha: 'a'.repeat(40), signer_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1'};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bongo-sign-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  for (const name of assetNames(metadata.version)) await writeFile(join(dir, name), Buffer.from(`synthetic fixture: ${name}`));
  const zipped = await readFile(join(dir, ARCHIVE));
  const m = {schema: 1, repository: REPOSITORY, version: metadata.version, platform: 'windows-x64', archive: ARCHIVE, size: zipped.length, sha256: createHash('sha256').update(zipped).digest('hex'), data_schema: 1, bootstrap_schema: 1};
  await writeFile(join(dir, 'update-manifest.json'), canonical(m));
  return {dir, m, ...keys()};
}
test('Version order rejects reuse, downgrade and malformed inputs', () => {
  assert.ok(newer('0.1.0.dev12', '0.1.0.dev11'));
  assert.ok(newer('0.1.0', '0.1.0.dev999'));
  assert.equal(newer('0.1.0.dev12', '0.1.0'), false);
  assert.equal(newer('0.1.0.dev11', '0.1.0.dev11'), false);
  for (const value of ['0.01.0', 'v1.0.0', '1.0.0;id', '../main', '', null]) assert.throws(() => version(value));
});
test('Raw seed import keeps standard Ed25519 signatures interoperable', () => {
  const k = keys();
  const data = Buffer.from('fixed input');
  assert.deepEqual(edSign(null, data, privateObject(k.seed, k.pinned)), edSign(null, data, k.privateKey));
  assert.throws(() => privateObject(k.seed), /pinned/);
});
test('Approval binds source, workflow attempt and every installer/source/update byte', async t => {
  const f = await fixture(t);
  const receipt = await approve(f.dir, metadata, f.seed, f.pinned);
  assert.equal(receipt.source_sha, metadata.source_sha);
  assert.deepEqual(await verifyApproved(f.dir, metadata, f.pinned), receipt);
  const raw = await readFile(join(f.dir, 'update-manifest.json'));
  assert.ok(edVerify(null, raw, f.publicKey, await readFile(join(f.dir, 'update-manifest.sig'))));
  assert.equal(edVerify(null, raw, f.publicKey, await readFile(join(f.dir, 'release-approval.sig'))), false);
  for (const field of ['version', 'source_sha', 'signer_sha', 'run_id', 'run_attempt']) {
    const changed = {...metadata, [field]: field.includes('sha') ? 'c'.repeat(40) : field === 'version' ? '0.1.0.dev13' : '2'};
    await assert.rejects(verifyApproved(f.dir, changed, f.pinned));
  }
});
test('Any approved asset tampering is rejected', async t => {
  const f = await fixture(t);
  await approve(f.dir, metadata, f.seed, f.pinned);
  for (const name of [...assetNames(metadata.version), 'update-manifest.sig', 'release-approval.json', 'release-approval.sig', 'SHA256SUMS.txt']) {
    const original = await readFile(join(f.dir, name));
    await writeFile(join(f.dir, name), Buffer.concat([original, Buffer.from('X')]));
    await assert.rejects(verifyApproved(f.dir, metadata, f.pinned), name);
    await writeFile(join(f.dir, name), original);
  }
});
test('Malformed manifests, extra files, wrong hash and mismatched key fail closed', async t => {
  const f = await fixture(t);
  for (const [field, value] of [['repository', 'attacker/repo'], ['version', '0.1.0.dev13'], ['size', -1], ['bootstrap_schema', 2], ['archive', '../payload']]) {
    assert.throws(() => manifest(canonical({...f.m, [field]: value}), metadata.version));
  }
  assert.throws(() => manifest(Buffer.from('{"schema":0,' + canonical(f.m).toString().slice(1)), metadata.version));
  await writeFile(join(f.dir, 'unexpected.py'), 'malicious fixture');
  await assert.rejects(approve(f.dir, metadata, f.seed, f.pinned), /Unexpected/);
  await rm(join(f.dir, 'unexpected.py'));
  await assert.rejects(approve(f.dir, metadata, keys().seed, f.pinned), /pinned/);
  await writeFile(join(f.dir, ARCHIVE), 'changed bytes');
  await assert.rejects(approve(f.dir, metadata, f.seed, f.pinned), /hash/);
});
test('Approval signatures use a separate domain from update manifests', () => {
  const k = keys();
  const raw = Buffer.from('test');
  const sig = edSign(null, Buffer.concat([DOMAIN, raw]), k.privateKey);
  assert.equal(edVerify(null, raw, k.publicKey, sig), false);
});
