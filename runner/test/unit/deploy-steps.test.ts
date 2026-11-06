// deploy.mjs's build steps (scripts/deploy-steps.mjs) with fake processes in
// place of npm: what a step says when its process never ran or was killed,
// and when the unit tests get a second go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

// A .mjs with no types, so imported by URL (typed any) rather than by name.
const steps = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'scripts', 'deploy-steps.mjs')).href);

type Run = { status: number | null; signal?: string | null; error?: Error; output?: string };

// Fake spawnSync: plays the runs in order, writing each one's output to the
// step's log as the real process would.
function fakeIo(runs: Run[]) {
  const said: string[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const io = {
    tmpdir: tmpDir(),
    say: (s: string) => said.push(s),
    write: (s: string) => said.push(s),
    error: () => {},
    spawn: (cmd: string, args: string[], opts: { stdio: [unknown, number, number] }) => {
      calls.push({ cmd, args });
      const r = runs.shift();
      assert.ok(r, `no run left for ${cmd} ${args.join(' ')}`);
      if (r.output) fs.writeSync(opts.stdio[1], r.output);
      return { status: r.status, signal: r.signal ?? null, error: r.error };
    },
  };
  return { io, said, calls };
}

const c = { npm: '/opt/node/bin/npm', node: '/opt/node/bin/node' };

test('step: a process that never started says why, in the error and its log', () => {
  const { io } = fakeIo([{ status: null, error: Object.assign(new Error('spawn /opt/node/bin/npm EAGAIN'), { code: 'EAGAIN' }) }]);
  assert.throws(
    () => steps.step('Unit tests', c.npm, ['test'], {}, io),
    (e: Error & { logFile: string }) => {
      assert.match(e.message, /Unit tests failed \(npm couldn't run: spawn \/opt\/node\/bin\/npm EAGAIN\); the whole output is in \S+$/);
      assert.match(fs.readFileSync(e.logFile, 'utf8'), /npm couldn't run: spawn \/opt\/node\/bin\/npm EAGAIN/);
      return true;
    },
  );
});

test('step: a killed process says which signal', () => {
  const { io } = fakeIo([{ status: null, signal: 'SIGKILL' }]);
  assert.throws(() => steps.step('Unit tests', c.npm, ['test'], {}, io), /Unit tests failed \(npm was stopped by SIGKILL\)/);
});

test('step: a plain failure says the exit code', () => {
  const { io } = fakeIo([{ status: 1, output: 'boom\n' }]);
  assert.throws(() => steps.step('Typecheck', c.npm, ['run', 'typecheck'], {}, io), /Typecheck failed \(npm exited with 1\); the whole output is in /);
});

test('step: long names keep distinct readable failure logs', () => {
  const { io } = fakeIo([{ status: 1, output: 'first failure\n' }, { status: 1, output: 'second failure\n' }]);
  const prefix = `Rerunning ${'test/unit/a-long-failed-test.test.ts, '.repeat(12)}`;
  const files: string[] = [];
  for (const name of [`${prefix}first`, `${prefix}second`]) {
    assert.throws(() => steps.step(name, c.node, [], {}, io), (e: Error & { logFile: string }) => {
      assert.ok(e instanceof steps.StepFailed);
      assert.ok(e.message.startsWith(`${name} failed`));
      files.push(e.logFile);
      return true;
    });
  }
  assert.notEqual(files[0], files[1]);
  assert.match(fs.readFileSync(files[0], 'utf8'), /first failure/);
  assert.match(fs.readFileSync(files[1], 'utf8'), /second failure/);
});

test('unitTests: a run that failed without naming a test file gets the whole suite once more', () => {
  // As on 4 Nov (THREADBEAR-M): npm test died in 0.1s with an empty log.
  const { io, said, calls } = fakeIo([{ status: null, signal: 'SIGKILL' }, { status: 0 }]);
  steps.unitTests(c, {}, io);
  assert.deepEqual(calls.map((x) => [x.cmd, ...x.args]), [[c.npm, 'test'], [c.npm, 'test']]);
  assert.ok(said.some((s) => /running them once more/.test(s)), said.join('\n'));
});

test('unitTests: a break that fails both whole runs still stops the build', () => {
  const { io, calls } = fakeIo([{ status: 1, output: 'Error: Cannot find module\n' }, { status: 1, output: 'Error: Cannot find module\n' }]);
  assert.throws(() => steps.unitTests(c, {}, io), /Unit tests, again failed \(npm exited with 1\)/);
  assert.equal(calls.length, 2);
});

test('unitTests: failed files are rerun alone, not the whole suite', () => {
  const output = 'not ok 1 - thing\ntest at test/unit/flaky.test.ts:12:3\n';
  const { io, said, calls } = fakeIo([{ status: 1, output }, { status: 0 }]);
  steps.unitTests(c, {}, io);
  assert.equal(calls[1].cmd, c.node);
  assert.ok(calls[1].args.includes('test/unit/flaky.test.ts'));
  assert.ok(calls[1].args.includes('--test-concurrency=1'));
  assert.ok(said.some((s) => /^Flaky: test\/unit\/flaky\.test\.ts/.test(s)), said.join('\n'));
});

test('unitTests: a test that fails twice stops the build', () => {
  const output = 'test at test/unit/broken.test.ts:1:1\n';
  const { io } = fakeIo([{ status: 1, output }, { status: 1, output }]);
  assert.throws(() => steps.unitTests(c, {}, io), /Rerunning test\/unit\/broken\.test\.ts failed \(node exited with 1\)/);
});

test('unitTests: many failed files still reach the test process', () => {
  const files = Array.from({ length: 12 }, (_, i) => `test/unit/a-long-failed-test-${i}.test.ts`);
  const output = files.map((file) => `test at ${file}:1:1`).join('\n');
  const { io, calls } = fakeIo([{ status: 1, output }, { status: 0 }]);
  steps.unitTests(c, {}, io);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.filter((arg) => arg.endsWith('.test.ts')), files);
});

// 90 s was too short with the Mac at a load of 94 on 18 cores (6 Nov): the
// release was fine and started in 7 s once it eased. The wait goes on while
// the Mac is that busy, up to a cap, and gives up at 90 s otherwise.
test('the smoke test waits longer for a release to listen while the Mac is overloaded', () => {
  assert.equal(steps.smokeTimedOut(89_000, 0.5), false);
  assert.equal(steps.smokeTimedOut(91_000, 0.5), true);
  assert.equal(steps.smokeTimedOut(91_000, 1.0), true);
  assert.equal(steps.smokeTimedOut(91_000, 5.2), false);
  assert.equal(steps.smokeTimedOut(9 * 60_000, 5.2), false);
  assert.equal(steps.smokeTimedOut(10 * 60_000 + 1, 5.2), true);
});
