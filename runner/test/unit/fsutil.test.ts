// A new runner's start sweeps up temp files from atomic writes a crash cut
// short. During a handover the old runner is still writing them without the
// lock, so the sweep must leave a living process's alone (THREADBEAR-9).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicWriteFileSync, removeTempFiles } from '../../src/fsutil.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fsutil-'));
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
}

test("the sweep leaves a living process's temp file, so its rename still works", (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const home = tmpDir();
  const thread = path.join(home, 'threads', 'abc');
  fs.mkdirSync(thread, { recursive: true });
  // What a draining runner has between writing and renaming.
  const tmp = path.join(thread, `.thread.json.${child.pid}.40df2704.tmp`);
  fs.writeFileSync(tmp, '{"saved":true}');

  assert.equal(removeTempFiles(home, path.join(home, 'threads')), 0);

  fs.renameSync(tmp, path.join(thread, 'thread.json'));
  assert.equal(fs.readFileSync(path.join(thread, 'thread.json'), 'utf8'), '{"saved":true}');
});

test("the sweep clears a dead process's temp files, in the folder and one level down", () => {
  const home = tmpDir();
  const pid = deadPid();
  fs.mkdirSync(path.join(home, 'threads', 'abc'), { recursive: true });
  const top = path.join(home, `.runner.json.${pid}.0a0b0c0d.tmp`);
  const nested = path.join(home, 'threads', 'abc', `.thread.json.${pid}.1a1b1c1d.tmp`);
  fs.writeFileSync(top, 'x');
  fs.writeFileSync(nested, 'x');
  const kept = path.join(home, 'notes.tmp');
  fs.writeFileSync(kept, 'not one of ours');

  assert.equal(removeTempFiles(home, path.join(home, 'threads')), 2);

  assert.equal(fs.existsSync(top), false);
  assert.equal(fs.existsSync(nested), false);
  assert.equal(fs.existsSync(kept), true);
});

test("a name that can't be a process doesn't hold a temp file back", () => {
  const home = tmpDir();
  // pid 0 would ask about our own process group, which is always there.
  const zero = path.join(home, '.a.json.0.0a0b0c0d.tmp');
  const huge = path.join(home, '.b.json.99999999999999.0a0b0c0d.tmp');
  fs.writeFileSync(zero, 'x');
  fs.writeFileSync(huge, 'x');
  assert.equal(removeTempFiles(home), 2);
});

test('a failed atomic write leaves no temp file behind', () => {
  const dir = tmpDir();
  // Renaming a file over a folder with something in it fails.
  const target = path.join(dir, 'thread.json');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'inside'), 'x');

  assert.throws(() => atomicWriteFileSync(target, '{}'));

  assert.deepEqual(fs.readdirSync(dir), ['thread.json']);
});
