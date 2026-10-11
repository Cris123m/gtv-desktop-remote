#!/usr/bin/env node
'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.env.GTV_INTEGRATION_USER_DATA);
const [command, ...args] = process.argv.slice(2);
function sandbox(value) {
  const resolved = path.resolve(value);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error('Native operation through escaping symlink');
  const canonical = path.join(real, path.relative(ancestor, resolved));
  if (!canonical.startsWith(root + path.sep))
    throw new Error('Native operation outside isolated profile');
  return canonical;
}
const statePath = path.join(root, 'native-operations.json');
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { operations: [] };
state.operations.push({ command, args });
fs.writeFileSync(statePath, JSON.stringify(state));
try {
  if (
    fs.existsSync(path.join(root, 'fail-native-command')) &&
    fs.readFileSync(path.join(root, 'fail-native-command'), 'utf8').trim() === command
  )
    throw new Error('Synthetic native failure');
  if (command === 'ditto') {
    const values = args.filter((arg) => !arg.startsWith('-'));
    const source = sandbox(values[0]);
    const destination = sandbox(values[1]);
    if (args.includes('-x')) {
      fs.mkdirSync(destination, { recursive: true });
      const listing = cp.execFileSync('unzip', ['-Z1', source], { encoding: 'utf8' });
      for (const member of listing.split('\n').filter(Boolean)) {
        if (member.startsWith('/') || member.split('/').includes('..'))
          throw new Error('Archive path traversal');
      }
      cp.execFileSync('unzip', ['-q', source, '-d', destination]);
    } else {
      // ditto merges a directory's contents into the destination, replacing
      // existing files without nesting another source directory beneath it.
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(source))
        fs.cpSync(path.join(source, entry), path.join(destination, entry), {
          recursive: true,
          force: true,
          preserveTimestamps: true,
        });
    }
  } else if (command === 'xattr') {
    const target = sandbox(args[args.length - 1]);
    fs.accessSync(target);
    fs.writeFileSync(path.join(root, 'quarantine-cleared.json'), JSON.stringify({ target }));
  } else if (command === 'rm')
    fs.rmSync(sandbox(args[args.length - 1]), { force: true, recursive: true });
  else if (command === 'open') {
    if (args.length !== 1) throw new Error('Expected one loopback URL');
    const url = new URL(args[0]);
    if (url.protocol !== 'http:' || !/^127\.\d+\.\d+\.\d+$/.test(url.hostname))
      throw new Error('External open must remain loopback');
    fs.writeFileSync(path.join(root, 'external-open.json'), JSON.stringify({ url: url.href }));
  } else throw new Error('Unsupported native fixture command: ' + command);
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 1;
}
