import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { approve, verifyApproved, assetNames, canonical, fileDigest, ARCHIVE, REPOSITORY } from '../scripts/sign.mjs';
import { publishRelease, releaseClient } from '../scripts/publish-release.mjs';

const expected = {version: '0.1.0.dev12', source_sha: 'a'.repeat(40), signer_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1'};
const releaseId = 741;
const tag = `v${expected.version}`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bongo-publish-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const approvedDirectory = join(root, 'approved');
  await mkdir(approvedDirectory);
  for (const name of assetNames(expected.version)) await writeFile(join(approvedDirectory, name), `synthetic: ${name}`);
  const archive = await readFile(join(approvedDirectory, ARCHIVE));
  await writeFile(join(approvedDirectory, 'update-manifest.json'), canonical({schema: 1, repository: REPOSITORY, version: expected.version, platform: 'windows-x64', archive: ARCHIVE, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), data_schema: 1, bootstrap_schema: 1}));
  const keys = generateKeyPairSync('ed25519');
  const seed = keys.privateKey.export({type: 'pkcs8', format: 'der'}).subarray(-32).toString('base64');
  const pinned = keys.publicKey.export({type: 'spki', format: 'der'}).subarray(-32).toString('base64');
  await approve(approvedDirectory, expected, seed, pinned);
  const names = [...assetNames(expected.version), 'update-manifest.sig', 'release-approval.json', 'release-approval.sig', 'SHA256SUMS.txt'].sort();
  const files = {};
  for (const name of names) files[name] = await fileDigest(join(approvedDirectory, name));
  const options = {expected, files, notes: 'Synthetic release', approvedDirectory, uploadedDirectory: join(root, 'uploaded')};
  const calls = [];
  const bytes = new Map();
  const state = {id: releaseId, tag_name: tag, draft: true, prerelease: false, assets: []};
  let verified = false;
  const client = {
    async api(path, request = {}) {
      calls.push({path, method: request.method ?? 'GET', body: request.body && JSON.parse(request.body)});
      if (path.startsWith('releases/tags/')) throw Error('GitHub API failure: 404');
      if (path === 'git/refs') return {};
      if (path === 'releases') {
        assert.equal(JSON.parse(request.body).draft, true);
        assert.equal(JSON.parse(request.body).target_commitish, expected.source_sha);
        return structuredClone(state);
      }
      assert.ok([`releases/${releaseId}`, 'releases/latest'].includes(path), path);
      if (request.method === 'PATCH') {
        assert.ok(verified, 'Publication must follow verification of downloaded bytes');
        assert.deepEqual(JSON.parse(request.body), {draft: false, prerelease: false, make_latest: 'true'});
        state.draft = false;
      }
      return structuredClone(state);
    },
    async upload(id, name, path) {
      assert.equal(id, releaseId);
      const data = await readFile(path);
      const asset = {id: 1000 + state.assets.length, name, size: data.length, state: 'uploaded'};
      state.assets.push(asset);
      bytes.set(asset.id, data);
    },
    async download(asset, path) { await writeFile(path, bytes.get(asset.id)); },
  };
  const verify = async (directory, metadata) => {
    await verifyApproved(directory, metadata, pinned);
    verified = true;
  };
  return {root, options, client, calls, state, bytes, verify, run: () => publishRelease(options, client, verify, () => {})};
}

test('Draft publication uses the created ID even when tag lookup returns 404', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.state.draft, false);
  assert.equal(f.state.assets.length, 11);
  assert.deepEqual(f.calls.map(c => `${c.method} ${c.path}`), [
    'POST git/refs', 'POST releases', `GET releases/${releaseId}`, `GET releases/${releaseId}`,
    `PATCH releases/${releaseId}`, 'GET releases/latest',
  ]);
});

test('Existing tags are never replaced and failed creation is not retried', async t => {
  const f = await fixture(t);
  f.client.api = async path => { f.calls.push(path); throw Error('GitHub API failure: 422'); };
  await assert.rejects(f.run(), /422/);
  assert.deepEqual(f.calls, ['git/refs']);
});

for (const [label, change] of [
  ['missing asset', assets => assets.pop()],
  ['duplicate asset name', assets => { assets[0].name = assets[1].name; }],
  ['duplicate asset ID', assets => { assets[0].id = assets[1].id; }],
  ['unfinished upload', assets => { assets[0].state = 'starter'; }],
  ['wrong size', assets => { assets[0].size++; }],
  ['invalid asset ID', assets => { assets[0].id = '../other'; }],
]) {
  test(`${label} prevents publication`, async t => {
    const f = await fixture(t);
    const api = f.client.api;
    f.client.api = async (path, request) => {
      const result = await api(path, request);
      if (path === `releases/${releaseId}`) change(result.assets);
      return result;
    };
    await assert.rejects(f.run(), /upload incomplete/);
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  });
}

test('Changed downloaded bytes cannot be published', async t => {
  const f = await fixture(t);
  const download = f.client.download;
  f.client.download = async (asset, path) => {
    await download(asset, path);
    if (asset.name === ARCHIVE) await writeFile(path, 'tampered');
  };
  await assert.rejects(f.run(), /Approved file changed/);
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
});

test('Asset replacement during verification is rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(publishRelease(f.options, f.client, async (...args) => {
    await f.verify(...args);
    f.state.assets[0].id = 9999;
  }, () => {}), /changed during verification/);
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
});

for (const [label, patch] of [
  ['invalid ID', {id: '741'}], ['wrong tag', {tag_name: 'v0.1.0.dev13'}],
  ['already public', {draft: false}], ['prerelease', {prerelease: true}],
]) {
  test(`Created release with ${label} is rejected`, async t => {
    const f = await fixture(t);
    Object.assign(f.state, patch);
    await assert.rejects(f.run(), /identity or state/);
    assert.equal(f.bytes.size, 0);
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  });
}

for (const method of ['upload', 'download']) {
  test(`${method} failure leaves the draft unpublished without retry`, async t => {
    const f = await fixture(t);
    let attempts = 0;
    f.client[method] = async () => { attempts++; throw Error('transfer failed'); };
    await assert.rejects(f.run(), /transfer failed/);
    assert.equal(attempts, 1);
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  });
}

test('A different latest release is not reported as success', async t => {
  const f = await fixture(t);
  const api = f.client.api;
  f.client.api = async (path, request) => {
    const result = await api(path, request);
    return path === 'releases/latest' ? {...result, id: 9999} : result;
  };
  await assert.rejects(f.run(), /identity or state/);
});

test('HTTP client streams uploads and downloads through fixed ID endpoints', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'downloaded.bin');
  const data = Buffer.from('synthetic streaming bytes');
  const source = join(f.root, 'source.bin');
  await writeFile(source, data);
  const client = releaseClient('synthetic-token', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    if (options.method === 'POST') {
      assert.equal(url, `https://uploads.github.com/repos/${REPOSITORY}/releases/741/assets?name=test%20file.bin`);
      assert.equal(options.headers['Content-Length'], String(data.length));
      assert.equal(options.duplex, 'half');
      assert.equal(options.redirect, 'error');
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), data);
      return Response.json({id: 8});
    }
    assert.equal(url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/8`);
    assert.equal(options.headers.Accept, 'application/octet-stream');
    return new Response(Readable.toWeb(Readable.from([data.subarray(0, 5), data.subarray(5)])));
  });
  await client.upload(releaseId, 'test file.bin', source);
  await client.download({id: 8, size: data.length}, path);
  assert.deepEqual(await readFile(path), data);
});

test('Download HTTP errors, oversized and truncated responses fail closed', async t => {
  const f = await fixture(t);
  for (const [label, response, size, error] of [
    ['http-error', new Response('not found', {status: 404}), 9, /GET releases\/assets\/8: 404/],
    ['oversized', new Response('too many bytes'), 3, /exceeds expected size/],
    ['truncated', new Response('few'), 100, /size mismatch/],
  ]) {
    const client = releaseClient('synthetic-token', async () => response);
    await assert.rejects(client.download({id: 8, size}, join(f.root, label)), error);
  }
});
