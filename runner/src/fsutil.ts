import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Write to a temp file in the same folder, fsync, then rename, so a crash
// never leaves a half-written thread.json behind.
export function atomicWriteFileSync(file: string, data: string | Buffer, mode?: number): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    try {
      if (typeof data === 'string') fs.writeSync(fd, data);
      else fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // A save that's tried again (Runner.flush) would otherwise leave one
    // behind each time, say while the disk is full.
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Removes the `.<name>.<pid>.<hex>.tmp` files atomicWriteFileSync (and
// token-tally.ts) leave if the process dies between writing and renaming.
// dirs are scanned one level down as well (the thread folders). A file whose
// pid is still running is left alone: during a handover the draining runner
// goes on saving without the runner lock, and sweeping its temp file
// mid-save made the save fail (THREADBEAR-9). A recycled pid only keeps a
// stale file until a later start.
export function removeTempFiles(...dirs: string[]): number {
  let removed = 0;
  const clean = (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const p = path.join(dir, d.name);
      const m = d.isFile() ? /^\..+\.(\d+)\.[0-9a-f]{8}\.tmp$/.exec(d.name) : null;
      if (m) {
        if (pidAlive(Number(m[1]))) continue;
        try {
          fs.unlinkSync(p);
          removed++;
        } catch {
          // gone already
        }
      } else if (d.isDirectory() && depth > 0) clean(p, depth - 1);
    }
  };
  for (const d of dirs) clean(d, 1);
  return removed;
}

function pidAlive(pid: number): boolean {
  // 0 or less would ask about a process group, which is always there.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it's there, just not ours to signal. Anything else (ESRCH, or
    // a number too big to be a pid) means no such process.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
