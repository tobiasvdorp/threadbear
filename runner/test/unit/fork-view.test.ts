// What someone else's copy of this repo shows from its own patches
// (.threadbear/patches): every chip and panel a thread in their fork gets.
// Wayne opened a thread in his fork on 6 Nov and found a Sentry chip
// pointing at Mike's Sentry, which he couldn't open and wasn't meant to see.
//
// The patches load here as on a stranger's Mac: a home folder with nothing
// of Mike's in it (no ~/dev/me/poddle, no keys), so a `when` that looks for
// something of Mike's comes out false. What's left must match SHOWN below.
// Adding to SHOWN means every fork shows it: only things anyone can use
// (public pages, the repo's own scripts), never Mike's accounts. Something
// only Mike needs gets a `when` that checks for something only he has, as
// app-store.ts's onMikesMac does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { applyLive, loadPatchSet, type CommandOutcome } from '../../src/patches.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SHOWN = {
  actions: [['Website', 'https://threadbear.mikecann.app/']],
  panels: ['Worktrees'],
};

// Things of Mike's that a stranger's copy must never show, whatever SHOWN
// says, so a careless update to SHOWN still fails.
const MIKES = [/mikec\.sentry\.io/, /appstoreconnect\.apple\.com/, /~\/dev\/me\//, /\/Users\/m5-mike/, /mikecann@|mike@cannstudios/];

test("a fork's own patches show nothing of Mike's", async () => {
  const home = tmpDir();
  const copy = path.join(home, 'dev', 'threadbear');
  fs.cpSync(path.join(REPO, '.threadbear'), path.join(copy, '.threadbear'), { recursive: true });
  const base = await loadPatchSet(copy, home);
  assert.deepEqual(base.patches.filter((p) => p.error).map((p) => `${p.id}: ${p.error}`), []);
  // Commands run in the real checkout, for git, but with the stranger's home.
  const run = async (command: string): Promise<CommandOutcome> => {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: REPO, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20_000 });
    return { ok: r.status === 0, exitCode: r.status ?? undefined, text: `${r.stdout ?? ''}${r.stderr ?? ''}`, truncated: false, durationMs: 0 };
  };
  const set = await applyLive(base, { cwd: copy, threadId: 'fork-view', run });

  const shown = JSON.stringify([set.actions, set.panels]);
  for (const mark of MIKES) assert.doesNotMatch(shown, mark);
  assert.deepEqual(
    {
      actions: set.actions.map((a) => [a.title, a.url ?? a.command ?? a.prompt]),
      panels: set.panels.map((p) => p.title),
    },
    SHOWN,
  );
});

// Text the app and runner show people or send to agents runs in every fork,
// where the person at the Mac isn't Mike. The investigate prompt told a
// fork's agent "Mike was pressing Trust..." and a closed question said
// "before Mike saw it" (fork-leak review, 8 Nov). Strings may still name
// Mike where he's meant: his releases that a fork follows from upstream, the
// About credit, and the push key only he can fix. Anything else says "the
// user" or "you". Comments are fine; debug-only Automation is skipped.
const MIKE_MEANT = [
  /Mike'?s (new |newer |latest )?releases?\b/,
  /releases? (from|Mike)|from Mike|Mike marked|Mike has a newer release|Mike hasn't made a release/i,
  /only Mike can fix/,
  /Made in Busselton by Mike/,
  /upstream remote \(Mike's repo\)/,
];

function sourceFiles(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.build' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p, ext));
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('strings shown or sent in a fork only name Mike where he is meant', () => {
  const files = [...sourceFiles(path.join(REPO, 'runner/src'), ['.ts']), ...sourceFiles(path.join(REPO, 'app/Sources'), ['.swift'])].filter((f) => !/\/Automation[^/]*\.swift$/.test(f));
  const found: string[] = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // Drop a comment: a whole-line one, or one after code (" // ").
      const code = /^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '');
      // Only text inside quotes or backticks.
      const strings = code.match(/(['"`])(?:\\.|(?!\1).)*\1/g) ?? [];
      for (const s of strings) if (/\bMike\b/.test(s) && !MIKE_MEANT.some((m) => m.test(s))) found.push(`${path.relative(REPO, file)}:${i + 1}: ${s.slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, []);
});
