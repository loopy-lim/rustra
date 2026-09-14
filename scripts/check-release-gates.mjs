import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WORKFLOWS = ['ci.yml', 'miri.yml', 'sanitizer.yml', 'fuzz.yml'];

function workflowMatches(run, workflow) {
  const requested = basename(workflow).toLowerCase();
  if (run.path) return basename(run.path).toLowerCase() === requested;
  return String(run.name ?? '').toLowerCase() === requested.replace(/\.ya?ml$/, '');
}

function allowedEvents(workflow) {
  return basename(workflow).toLowerCase() === 'ci.yml'
    ? new Set(['push', 'pull_request'])
    : new Set(['schedule', 'workflow_dispatch', 'workflow_call']);
}

function compareRuns(left, right) {
  const activityTime = (run) =>
    Math.max(
      ...[run.updated_at, run.run_started_at, run.created_at]
        .map((value) => Date.parse(value ?? ''))
        .filter(Number.isFinite),
    );
  const time = activityTime(right) - activityTime(left);
  if (Number.isFinite(time) && time !== 0) return time;
  if ((right.id ?? 0) !== (left.id ?? 0)) return (right.id ?? 0) - (left.id ?? 0);
  return (right.run_attempt ?? 0) - (left.run_attempt ?? 0);
}

export function evaluateRuns(runs, { sha, workflow, repository }) {
  const events = allowedEvents(workflow);
  const candidates = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.repository?.full_name === repository &&
        run.head_repository?.full_name === repository &&
        workflowMatches(run, workflow) &&
        events.has(run.event),
    )
    .sort(compareRuns);
  const selected = candidates[0] ?? null;

  if (!selected) {
    return { ok: false, workflow, reason: 'no exact-source run found', run: null };
  }
  const receiptRun = {
    id: selected.id,
    run_attempt: selected.run_attempt,
    name: selected.name,
    path: selected.path,
    head_sha: selected.head_sha,
    event: selected.event,
    status: selected.status,
    conclusion: selected.conclusion,
    created_at: selected.created_at,
    run_started_at: selected.run_started_at,
    updated_at: selected.updated_at,
    html_url: selected.html_url,
    repository: selected.repository.full_name,
  };
  if (!Number.isInteger(selected.run_attempt) || selected.run_attempt < 1) {
    return {
      ok: false,
      workflow,
      reason: `latest exact-source run has invalid run_attempt=${selected.run_attempt ?? 'missing'}`,
      run: receiptRun,
    };
  }
  if (selected.status !== 'completed' || selected.conclusion !== 'success') {
    return {
      ok: false,
      workflow,
      reason: `latest exact-source run is status=${selected.status ?? 'missing'} conclusion=${selected.conclusion ?? 'missing'}`,
      run: receiptRun,
    };
  }
  return { ok: true, workflow, reason: null, run: receiptRun };
}

async function fetchWorkflowRuns({ repository, sha, workflow, fetchImpl, token }) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
    );
    url.searchParams.set('head_sha', sha);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub Actions API ${response.status} for ${workflow} page ${page}`);
    }
    const body = await response.json();
    if (!Array.isArray(body.workflow_runs)) {
      throw new Error(`GitHub Actions API returned invalid workflow_runs for ${workflow}`);
    }
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) return runs;
  }
}

export async function auditReleaseGates({
  repository,
  sha,
  workflows = DEFAULT_WORKFLOWS,
  fetchImpl = fetch,
  token,
  now = () => new Date(),
}) {
  if (!repository) throw new Error('repository is required');
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) throw new Error('sha must be a full 40-character SHA');
  if (!token) throw new Error('GitHub token is required');

  const gates = [];
  for (const workflow of workflows) {
    const runs = await fetchWorkflowRuns({ repository, sha, workflow, fetchImpl, token });
    gates.push(evaluateRuns(runs, { sha, workflow, repository }));
  }
  return {
    ok: gates.every((gate) => gate.ok),
    repository,
    sha,
    checked_at: now().toISOString(),
    gates,
  };
}

function parseArgs(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    workflows: DEFAULT_WORKFLOWS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ci-only') options.workflows = ['ci.yml'];
    else if (arg === '--repository') options.repository = argv[++index];
    else if (arg === '--sha') options.sha = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function run() {
  let receipt;
  try {
    receipt = await auditReleaseGates(parseArgs(process.argv.slice(2)));
  } catch (error) {
    receipt = {
      ok: false,
      repository: process.env.GITHUB_REPOSITORY ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      gates: [],
    };
  }
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.ok) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await run();
