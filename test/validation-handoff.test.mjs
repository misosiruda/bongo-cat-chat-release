import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dispatchValidation } from '../scripts/validation-handoff.mjs';

const sha = 'a'.repeat(40);
const env = {
  SOURCE_SHA: sha, RELEASE_VERSION: '1.0.3', ALLOW_UNSIGNED: 'true',
  GITHUB_REPOSITORY: 'misosiruda/bongo-cat-chat-release', GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_NUMBER: '8', GITHUB_EVENT_NAME: 'workflow_dispatch', GH_TOKEN: 'fixture'
};
const run = (title, run_number = 2, id = 32) => ({ id, status: 'completed', display_title: title + ' 1.0.3 from ' + sha, run_number });
function fake({ target = [], helpers = [], jobs = [], post = () => Response.json({workflow_run_id: 57}) } = {}) {
  const calls = [];
  const fetcher = (url, options) => {
    calls.push({url, options});
    if (options.method === 'POST') return post();
    if (url.includes('/jobs?')) return Response.json({jobs});
    const workflow_runs = url.includes('validate-reviewed-main.yml') ? helpers : target;
    return Response.json({workflow_runs, total_count: workflow_runs.length});
  };
  return { calls, fetcher, get posts() { return calls.filter(c => c.options.method === 'POST'); } };
}

test('approved main invocation can dispatch only validation with exact inputs', async () => {
  const f = fake({helpers: [run('Validate', 8), run('Validate', 9)]});
  assert.match(await dispatchValidation(env, f.fetcher), /runs\/57$/);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].url, /bongo-cat-chat-release\/actions\/workflows\/release\.yml\/dispatches$/);
  assert.equal(f.posts[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(f.posts[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(f.posts[0].options.body), {
    ref: 'main', inputs: {source_sha: sha, version: '1.0.3', allow_unsigned_windows: true, validation_only: true}
  });
});

test('missing acknowledgement, invalid source, other ref/event/repo and reruns stop before API access', async () => {
  for (const bad of [
    {ALLOW_UNSIGNED:'false'}, {SOURCE_SHA:'main'}, {RELEASE_VERSION:'1.0.3; echo injected'},
    {GITHUB_REF:'refs/heads/feature'}, {GITHUB_RUN_ATTEMPT:'2'},
    {GITHUB_REPOSITORY:'someone/fork'}, {GITHUB_EVENT_NAME:'pull_request'}
  ]) {
    const f = fake();
    await assert.rejects(dispatchValidation({...env, ...bad}, f.fetcher));
    assert.equal(f.calls.length, 0);
  }
});

test('reuses exact validation run and halts if same-tuple earlier helper was ambiguous', async () => {
  const exact = fake({target:[run('Validation only')]});
  assert.match(await dispatchValidation(env, exact.fetcher), /Existing validation run:.*32$/);
  assert.equal(exact.posts.length, 0);
  const ambiguous = fake({helpers:[run('Validate')]});
  await assert.rejects(dispatchValidation(env, ambiguous.fetcher), /Earlier helper request/);
  assert.equal(ambiguous.posts.length, 0);
});

test('legacy title is allowed only for one proven regular signing run', async () => {
  const r = run('Release');
  const signed = {name:'sign', conclusion:'success'};
  const yes = fake({target:[r], jobs:[signed]});
  await dispatchValidation(env, yes.fetcher);
  assert.equal(yes.posts.length, 1);
  for (const f of [fake({target:[r]}), fake({target:[r, run('Release', 3, 33)], jobs:[signed]})]) {
    await assert.rejects(dispatchValidation(env, f.fetcher), /Earlier release run/);
    assert.equal(f.posts.length, 0);
  }
});

test('does not compete with another active release workflow request', async () => {
  const f = fake({target:[{...run('Release'), display_title:'another release', status:'waiting'}]});
  await assert.rejects(dispatchValidation(env, f.fetcher), /already active/);
  assert.equal(f.posts.length, 0);
});

test('malformed evidence and uncertain POST never trigger an automatic retry', async () => {
  const invalid = fake({target:[{...run('Validation only'), display_title:null}]});
  await assert.rejects(dispatchValidation(env, invalid.fetcher), /incomplete/);
  assert.equal(invalid.posts.length, 0);
  for (const post of [
    () => new Response(null, {status:204}),
    () => Response.json({workflow_run_id: null}),
    () => { throw Error('timeout'); }
  ]) {
    const f = fake({post});
    await assert.rejects(dispatchValidation(env, f.fetcher), /outcome uncertain/);
    assert.equal(f.posts.length, 1);
  }
});

test('helper does not expose release mode or alter signing gate', async () => {
  const helper = await readFile(new URL('../.github/workflows/validate-reviewed-main.yml', import.meta.url), 'utf8');
  const target = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(helper, /^on:\n  workflow_dispatch:/m);
  assert.match(helper, /^    permissions:\n      contents: read\n      actions: write$/m);
  assert.doesNotMatch(helper, /validation_only:|release-signing|release-publishing|contents: write|secrets\./);
  assert.match(target, /sign:\n    needs: \[build, inspect\]\n    if: \$\{\{ !inputs.validation_only \}\}/);
  assert.match(target, /name: release-signing/);
});
