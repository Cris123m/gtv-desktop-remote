import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import semanticRelease from 'semantic-release';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, '.releaserc.json'), 'utf8'));
// Use the production analyzer, its actual rules, and the production notes generator.
// Never load npm/git/GitHub publication plugins, even in dry-run mode.
const previewPlugins = config.plugins
  .filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return (
      name === './scripts/analyze-release-commits.mjs' ||
      name === '@semantic-release/release-notes-generator'
    );
  })
  .map((plugin) => {
    if (Array.isArray(plugin) && plugin[0].startsWith('./')) {
      return [resolve(root, plugin[0]), plugin[1]];
    }
    return plugin;
  });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t, historical = false) {
  const directory = mkdtempSync(join(tmpdir(), 'gtv-release-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repository');
  const remote = join(directory, 'remote.git');
  git(directory, 'init', '--initial-branch=main', cwd);
  git(directory, 'init', '--bare', '--initial-branch=main', remote);
  git(cwd, 'config', 'user.name', 'Release policy fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  if (historical) {
    // Keep the real pre-major history reproducible after future production releases.
    const historicalHead = '794b3c7e6af08b20ede57585d748fa9f7a1e6b4b';
    git(
      cwd,
      'fetch',
      '--no-tags',
      pathToFileURL(root).href,
      historicalHead,
      'refs/tags/v1.6.4:refs/tags/v1.6.4'
    );
    git(cwd, 'checkout', '-B', 'main', historicalHead);
  } else {
    git(cwd, 'commit', '--allow-empty', '-m', 'chore: initial fixture');
  }
  git(cwd, 'remote', 'add', 'origin', pathToFileURL(remote).href);
  return { cwd, remote };
}

function commit(cwd, message) {
  git(cwd, 'commit', '--allow-empty', '-m', message);
}

async function preview({ cwd, remote }, expectedVersion, expectedType, expectedBase) {
  git(cwd, 'push', 'origin', 'main', '--tags');
  const before = git(cwd, 'show-ref');
  const remoteBefore = git(remote, 'show-ref');
  const info = JSON.parse(
    execFileSync(process.execPath, [join(root, 'scripts/resolve-release-version.mjs')], {
      cwd,
      encoding: 'utf8',
    })
  );
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  // An empty environment disables CI/PR auto-detection and contains no API tokens.
  const result = await semanticRelease(
    {
      branches: config.branches,
      repositoryUrl: pathToFileURL(remote).href,
      plugins: previewPlugins,
      dryRun: true,
      ci: false,
    },
    { cwd, env: {}, stdout: sink, stderr: sink }
  );
  assert.equal(info.lastTag, expectedBase);
  assert.equal(info.version, expectedVersion);
  assert.equal(info.releaseType, expectedType);
  assert.equal(info.willRelease, expectedType !== null);
  if (expectedType === null) {
    assert.equal(result, false);
  } else {
    assert.equal(result.nextRelease.version, info.version);
    assert.equal(result.nextRelease.type, info.releaseType);
    assert.equal(result.nextRelease.gitTag, `v${expectedVersion}`);
    assert.ok(result.nextRelease.notes.includes(expectedVersion));
  }
  assert.equal(git(cwd, 'show-ref'), before, 'dry-run must not mutate local refs');
  assert.equal(git(remote, 'show-ref'), remoteBefore, 'dry-run must not mutate remote refs');
  console.log(
    JSON.stringify({
      base: expectedBase,
      resolver: info.version,
      semanticRelease: result ? result.nextRelease.version : null,
      releaseType: expectedType,
    })
  );
}

test('actual repository history since v1.6.4 selects v2.0.0 in both consumers', async (t) => {
  await preview(fixture(t, true), '2.0.0', 'major', 'v1.6.4');
});

test('one-time policy expires at v2.0.0 and normal patch/minor rules resume', async (t) => {
  const repository = fixture(t);
  git(repository.cwd, 'tag', 'v1.6.4');
  await preview(repository, '1.6.4', null, 'v1.6.4');
  commit(repository.cwd, 'feat: add remote controls');
  commit(repository.cwd, 'fix: correct release artifact');
  await preview(repository, '2.0.0', 'major', 'v1.6.4');
  git(repository.cwd, 'tag', 'v2.0.0');
  await preview(repository, '2.0.0', null, 'v2.0.0');
  commit(repository.cwd, 'fix: correct remote control');
  await preview(repository, '2.0.1', 'patch', 'v2.0.0');
  git(repository.cwd, 'tag', 'v2.0.1');
  commit(repository.cwd, 'feat: add control');
  await preview(repository, '2.1.0', 'minor', 'v2.0.1');
});

test('the v1 policy is intentional even for documentation-only commits', async (t) => {
  const repository = fixture(t);
  git(repository.cwd, 'tag', 'v1.6.4');
  commit(repository.cwd, 'docs: describe the next major');
  await preview(repository, '2.0.0', 'major', 'v1.6.4');
  git(repository.cwd, 'tag', 'v2.0.0');
  commit(repository.cwd, 'docs: describe controls');
  await preview(repository, '2.0.0', null, 'v2.0.0');
});

test('post-major refactor/perf rules and real breaking changes remain conventional', async (t) => {
  const repository = fixture(t);
  git(repository.cwd, 'tag', 'v2.0.0');
  commit(repository.cwd, 'refactor: simplify controls');
  commit(repository.cwd, 'perf: reduce command latency');
  await preview(repository, '2.0.1', 'patch', 'v2.0.0');
  git(repository.cwd, 'tag', 'v2.0.1');
  commit(repository.cwd, 'feat: replace command API\n\nBREAKING CHANGE: remove the old command API');
  await preview(repository, '3.0.0', 'major', 'v2.0.1');
});

test('untagged repositories retain the normal initial version', async (t) => {
  const repository = fixture(t);
  commit(repository.cwd, 'feat: initial control');
  await preview(repository, '1.0.0', 'minor', '');
});
