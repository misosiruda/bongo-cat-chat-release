import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPOSITORY, verifyApproved } from './sign.mjs';

const validId = value => Number.isSafeInteger(value) && value > 0;
const jsonOptions = (method, body) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

// URLs are constructed from fixed hosts/repository and numeric IDs, never response URLs.
export function releaseClient(token, fetcher = fetch) {
  async function request(host, path, options = {}) {
    const response = await fetcher(`https://${host}/repos/${REPOSITORY}/${path}`, {
      ...options,
      headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...options.headers},
    });
    if (!response.ok) throw Error(`GitHub API failure: ${options.method ?? 'GET'} ${path}: ${response.status}`);
    return response;
  }
  return {
    api: async (path, options) => (await request('api.github.com', path, options)).json(),
    upload: async (releaseId, name, path) => {
      if (!validId(releaseId)) throw Error('Invalid release ID');
      const size = (await lstat(path)).size;
      const body = createReadStream(path);
      try {
        const response = await request('uploads.github.com', `releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
          method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(size)},
          body, duplex: 'half', redirect: 'error',
        });
        await response.json();
      } finally {
        body.destroy();
      }
    },
    download: async (asset, path) => {
      if (!validId(asset.id)) throw Error('Invalid asset ID');
      const response = await request('api.github.com', `releases/assets/${asset.id}`, {headers: {Accept: 'application/octet-stream'}});
      let bytes = 0;
      const bound = new Transform({transform(chunk, encoding, done) {
        bytes += chunk.length;
        done(bytes > asset.size ? Error('Downloaded asset exceeds expected size') : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(path, {flags: 'wx'}));
      if (bytes !== asset.size) throw Error('Downloaded asset size mismatch');
    },
  };
}

function checkRelease(release, id, tag, draft) {
  if (!validId(release.id) || release.id !== id || release.tag_name !== tag || release.draft !== draft || release.prerelease !== false) {
    throw Error('Release identity or state mismatch');
  }
}

function checkAssets(assets, expectedFiles) {
  const names = Object.keys(expectedFiles).sort();
  if (!Array.isArray(assets) || assets.map(a => a.name).sort().join() !== names.join() ||
      new Set(assets.map(a => a.id)).size !== names.length ||
      assets.some(a => !validId(a.id) || a.state !== 'uploaded' || a.size !== expectedFiles[a.name].size)) {
    throw Error('Draft asset upload incomplete or mismatched');
  }
}

// Called only after candidate signature/provenance/version checks and the dry-run gate.
export async function publishRelease({expected, files, notes, approvedDirectory, uploadedDirectory}, client, verify = verifyApproved, log = console.log) {
  const tag = `v${expected.version}`;
  await client.api('git/refs', jsonOptions('POST', {ref: `refs/tags/${tag}`, sha: expected.source_sha}));
  const created = await client.api('releases', jsonOptions('POST', {
    tag_name: tag, target_commitish: expected.source_sha, name: `Bongo Cat Chat ${expected.version} 개발판`,
    body: notes, draft: true, prerelease: false,
  }));
  const id = created.id;
  checkRelease(created, id, tag, true);
  log(`Created draft release ID ${id}; failures leave this draft/tag for manual investigation.`);
  for (const name of Object.keys(files).sort()) await client.upload(id, name, join(approvedDirectory, name));
  const draft = await client.api(`releases/${id}`);
  checkRelease(draft, id, tag, true);
  checkAssets(draft.assets, files);
  await mkdir(uploadedDirectory);
  for (const asset of draft.assets) await client.download(asset, join(uploadedDirectory, asset.name));
  await verify(uploadedDirectory, expected);
  // Re-read before publishing to reject an altered asset list during verification.
  const ready = await client.api(`releases/${id}`);
  checkRelease(ready, id, tag, true);
  checkAssets(ready.assets, files);
  if (ready.assets.some(a => !draft.assets.some(b => a.id === b.id && a.name === b.name))) throw Error('Draft assets changed during verification');
  const published = await client.api(`releases/${id}`, jsonOptions('PATCH', {draft: false, prerelease: false, make_latest: 'true'}));
  checkRelease(published, id, tag, false);
  const latest = await client.api('releases/latest');
  checkRelease(latest, id, tag, false);
  log(`Verified release ID ${id} published to the existing application update feed.`);
}
