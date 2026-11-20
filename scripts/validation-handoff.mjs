import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const control = 'misosiruda/bongo-cat-chat-release';
const workflow = 'release.yml';
const helper = 'validate-reviewed-main.yml';
const actions = 'https://api.github.com/repos/' + control + '/actions/workflows/';
const webRun = id => 'https://github.com/' + control + '/actions/runs/' + id;
const validId = id => Number.isSafeInteger(id) && id > 0;

export async function dispatchValidation(env, fetcher = fetch, note = async () => {}) {
  const { SOURCE_SHA: sha, RELEASE_VERSION: version } = env;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.dev(0|[1-9]\d*))?$/.test(version ?? '') ||
      version.length > 48 || env.ALLOW_UNSIGNED !== 'true') {
    throw Error('Exact app SHA, version and explicit unsigned Windows acknowledgement required');
  }
  const runNumber = Number(env.GITHUB_RUN_NUMBER);
  if (env.GITHUB_REPOSITORY !== control || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1' ||
      !validId(runNumber) || !env.GH_TOKEN) throw Error('Expected initial helper dispatch on control repository main');

  const api = (workflowName, suffix, options) => fetcher(actions + workflowName + '/' + suffix, {
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2026-03-10',
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(15000),
    ...options
  });
  const existing = async (workflowName, match) => {
    for (let page = 1; page <= 10; page++) {
      const result = await api(workflowName, 'runs?branch=main&event=workflow_dispatch&per_page=100&page=' + page);
      if (!result.ok) throw Error('Cannot reconcile run history: HTTP ' + result.status);
      const data = await result.json();
      if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) ||
          data.total_count < 0 || data.total_count >= 1000 ||
          data.workflow_runs.some(r => !validId(r.id) || !validId(r.run_number) || typeof r.display_title !== 'string' || typeof r.status !== 'string')) {
        throw Error('Run history is incomplete or unrecognized; no dispatch');
      }
      const run = data.workflow_runs.find(match);
      if (run) return run;
      if (page * 100 >= data.total_count) return null;
      if (data.workflow_runs.length !== 100) throw Error('Run history pagination is incomplete; no dispatch');
    }
    throw Error('Run history too large; no dispatch');
  };

  const suffix = version + ' from ' + sha;
  const exact = await existing(workflow, r => r.display_title === 'Validation only ' + suffix);
  if (exact) {
    const result = 'Existing validation run: ' + webRun(exact.id);
    await note(result);
    return result;
  }
  const pendingOrPrevious = await existing(helper, r =>
    r.run_number < runNumber && r.display_title === 'Validate ' + suffix);
  if (pendingOrPrevious) {
    const result = 'Earlier helper request needs reconciliation before any retry: ' + webRun(pendingOrPrevious.id);
    await note(result);
    throw Error(result);
  }
  // Historical titles did not encode mode. Treat them conservatively unless a
  // human has established an earlier run was not a validation request.
  const legacy = await existing(workflow, r => r.display_title === 'Release ' + suffix);
  if (legacy) {
    const response = await fetcher('https://api.github.com/repos/' + control +
      '/actions/runs/' + legacy.id + '/jobs?per_page=100', {
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + env.GH_TOKEN,
        'X-GitHub-Api-Version': '2026-03-10'
      },
      signal: AbortSignal.timeout(15000)
    });
    const jobs = response.ok ? (await response.json()).jobs : null;
    // The regular workflow actually signed, so this exact legacy run was not
    // validation-only. It is still unsafe to assume older same-title runs were
    // signing runs; reject unless the title was unique in history.
    if (!Array.isArray(jobs) || !jobs.some(job => job.name === 'sign' && job.conclusion === 'success') ||
        await existing(workflow, r => r.id !== legacy.id && r.display_title === 'Release ' + suffix)) {
      const result = 'Earlier release run needs reconciliation: ' + webRun(legacy.id);
      await note(result);
      throw Error(result);
    }
  }

  const busy = await existing(workflow, r => r.status !== 'completed');
  if (busy) {
    const result = 'Release workflow already active; no dispatch: ' + webRun(busy.id);
    await note(result);
    throw Error(result);
  }
  await note('Request: ' + suffix + '; validation_only=true, no signing/publication.');
  try {
    const result = await api(workflow, 'dispatches', {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: {
        source_sha: sha, version, allow_unsigned_windows: true, validation_only: true
      } })
    });
    if (result.status !== 200) throw Error('HTTP ' + result.status);
    const { workflow_run_id: id } = await result.json();
    if (!validId(id)) throw Error('missing workflow run ID');
    const done = 'Dispatched validation run: ' + webRun(id);
    await note(done);
    return done;
  } catch (err) {
    throw Error('Dispatch outcome uncertain; reconcile existing runs before any retry: ' + err.message);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await dispatchValidation(process.env, fetch, async line => {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, line + '\n');
  }));
}
