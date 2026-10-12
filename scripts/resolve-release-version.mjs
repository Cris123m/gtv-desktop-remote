#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { analyzeCommits } from './analyze-release-commits.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);

  if (!match) {
    throw new Error(`Unsupported version tag: ${tag}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function incrementVersion(version, releaseType) {
  if (releaseType === 'major') {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }

  if (releaseType === 'minor') {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }

  if (releaseType === 'patch') {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }

  return version;
}

const headRef = process.argv[2] || 'HEAD';
let lastTag;

try {
  lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', headRef]);
} catch {
  lastTag = '';
}

const range = lastTag ? `${lastTag}..${headRef}` : headRef;
const rawMessages = git(['log', '--format=%H%x1f%B%x1e', range]);
const commits = rawMessages
  .split('\x1e')
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [hash, ...message] = record.split('\x1f');
    return { hash, message: message.join('\x1f').trim() };
  });
const releaseConfig = JSON.parse(
  readFileSync(new URL('../.releaserc.json', import.meta.url), 'utf8')
);
const [, analyzerConfig] = releaseConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === './scripts/analyze-release-commits.mjs'
);
const releaseType = await analyzeCommits(analyzerConfig, {
  cwd: process.cwd(),
  commits,
  lastRelease: { version: lastTag.replace(/^v/, '') },
  logger: { log() {} },
});

const previousVersion = lastTag ? parseVersion(lastTag) : { major: 0, minor: 0, patch: 0 };
const nextVersion = releaseType ? incrementVersion(previousVersion, releaseType) : previousVersion;
const willRelease = releaseType !== null;
const initialRelease = !lastTag && willRelease;

process.stdout.write(
  JSON.stringify(
    {
      lastTag,
      releaseType,
      willRelease,
      version: initialRelease ? '1.0.0' : formatVersion(nextVersion),
      commitCount: commits.length,
    },
    null,
    2
  )
);
