// A thread's messages never reach the mirror while its row there is still
// shared by a link Mike has stopped or replaced: share:view reads the row's
// share and returns the messages (Daybreak, 8 Nov, "Startup settling leaks new
// messages through revoked share links"). The fake backend here keeps each
// row's share as the last upsert left it (upsertThreads replaces the row) and
// records, for every message appended, the link the row had at that moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { ConvexSync, BACKEND_API_VERSION, SETTLE_MS, type ThreadDoc } from '../../src/sync.ts';
import { nullLogger } from '../../src/log.ts';

type Msg = { threadId: string; seq: number; text: string };

function setup() {
  const h = makeHarness();
  const cachePath = path.join(tmpDir('tb-sync-share-'), 'sync-sent.json');
  const statePath = path.join(path.dirname(cachePath), 'sync-state.json');
  // The mirror: each row's share, and what an anonymous holder of each slug
  // could read through share:view (messages appended while it was "link").
  const share = new Map<string, { access: string; slug: string } | undefined>();
  const readable: { slug: string; msg: Msg }[] = [];
  const appended: Msg[] = [];
  const skipRows = new Set<string>();
  const failUpsert = { value: false };
  const make = () =>
    new ConvexSync({
      config: { enabled: true, url: 'https://x.convex.cloud', name: 'TestMac', runnerId: 'r1' },
      key: 'k',
      runner: h.runner,
      version: '0.1.0+test',
      startedAt: '2026-10-27T00:00:00.000Z',
      clock: h.clock,
      log: nullLogger,
      cachePath,
      statePath,
      home: h.home,
      subscriber: { subscribe: () => () => {}, close: async () => {} },
      post: async (_kind, fn, args) => {
        if (fn === 'sync:heartbeat') return { apiVersion: BACKEND_API_VERSION };
        if (fn === 'sync:upsertThreads') {
          if (failUpsert.value) throw new Error('down');
          const skipped: string[] = [];
          for (const t of args.threads as ThreadDoc[]) {
            if (skipRows.has(t.threadId)) {
              skipped.push(t.threadId);
              continue;
            }
            share.set(t.threadId, t.share);
          }
          return skipped.length ? { skipped } : null;
        }
        if (fn === 'sync:appendMessages') {
          for (const m of args.messages as Msg[]) {
            appended.push(m);
            const s = share.get(m.threadId);
            if (s?.access === 'link') readable.push({ slug: s.slug, msg: m });
          }
          return null;
        }
        if (fn === 'sync:sharedThreads') return [...share].filter(([, s]) => s?.access === 'link').map(([id]) => id);
        if (fn === 'sync:messageHeads') return [];
        return null;
      },
    });
  return { h, make, share, readable, appended, skipRows, failUpsert };
}

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

// Lets the sync's own timers run (no flushNow, which ends the settle early).
async function run(s: ReturnType<typeof setup>, ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    s.h.clock.advance(Math.min(500, left));
    await tick();
  }
}

async function sharedThenRestart(s: ReturnType<typeof setup>) {
  const t = s.h.runner.create({ text: 'hello', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  const slug = s.h.runner.share(t.id, { access: 'link' }).thread.share!.slug;
  const first = s.make();
  first.start();
  await tick();
  await first.flushNow();
  await run(s, 3000);
  await first.flushNow();
  await first.stop();
  assert.equal(s.share.get(t.id)?.access, 'link', 'the mirror has the link');
  return { t, slug };
}

for (const how of ['stop sharing', 'a new link'] as const) {
  test(`${how} in the settle after a cached start goes before the thread's next message`, async () => {
    const s = setup();
    const { t, slug } = await sharedThenRestart(s);
    const again = s.make();
    again.start();
    await run(s, 1000);
    if (how === 'stop sharing') s.h.runner.share(t.id, { access: 'off' });
    else s.h.runner.share(t.id, { access: 'link', newLink: true });
    s.h.runner.send(t.id, 'POST-REVOCATION PRIVATE TEXT');
    await run(s, 4000); // well inside SETTLE_MS
    assert.ok(4000 + 1000 < SETTLE_MS);
    assert.ok(s.appended.some((m) => m.text === 'POST-REVOCATION PRIVATE TEXT'), 'the message did go up');
    assert.deepEqual(s.readable.filter((r) => r.slug === slug && r.msg.text === 'POST-REVOCATION PRIVATE TEXT'), [], 'never readable through the old link');
    if (how === 'stop sharing') assert.equal(s.share.get(t.id)?.access, 'off');
    else assert.notEqual(s.share.get(t.id)?.slug, slug);
    await again.stop();
  });
}

test('a share stopped while the runner was down is written before any of the thread\'s messages', async () => {
  const s = setup();
  const { t, slug } = await sharedThenRestart(s);
  s.h.runner.share(t.id, { access: 'off' });
  s.h.runner.send(t.id, 'written while sync was off');
  await tick();
  const again = s.make();
  again.start();
  await run(s, 4000);
  assert.equal(s.share.get(t.id)?.access, 'off', 'stopped in the mirror inside the settle');
  assert.deepEqual(s.readable.filter((r) => r.slug === slug && r.msg.text === 'written while sync was off'), []);
  await again.stop();
});

test('a stop the backend leaves out holds the thread\'s messages back, and they go once it lands', async () => {
  const s = setup();
  const { t, slug } = await sharedThenRestart(s);
  const again = s.make();
  again.start();
  await again.flushNow();
  s.skipRows.add(t.id);
  s.h.runner.share(t.id, { access: 'off' });
  s.h.runner.send(t.id, 'after the stop');
  await run(s, 6000);
  assert.equal(s.share.get(t.id)?.access, 'link', 'the row was left out');
  assert.ok(!s.appended.some((m) => m.text === 'after the stop'), 'its message waits');
  // Another thread's messages still go.
  const other = s.h.runner.create({ text: 'unrelated', cwd: s.h.cfg.defaults.cwd, accountId: 'claude-3' }).thread;
  await run(s, 3000);
  assert.ok(s.appended.some((m) => m.threadId === other.id), 'other threads are not held up');
  // The backend takes it next time: the row, then the message.
  s.skipRows.clear();
  s.h.runner.update({ threadId: t.id, title: 'Renamed' });
  await run(s, 3000);
  await again.flushNow();
  assert.equal(s.share.get(t.id)?.access, 'off');
  assert.ok(s.appended.some((m) => m.text === 'after the stop'), 'it goes once the row is up');
  assert.deepEqual(s.readable.filter((r) => r.slug === slug && r.msg.text === 'after the stop'), []);
  await again.stop();
});

test('a stop whose write failed, maybe after landing, keeps messages back until a write goes through', async () => {
  const s = setup();
  const { t, slug } = await sharedThenRestart(s);
  const again = s.make();
  again.start();
  await again.flushNow();
  s.failUpsert.value = true;
  s.h.runner.share(t.id, { access: 'off' });
  s.h.runner.send(t.id, 'during the outage');
  await run(s, 6000);
  assert.ok(!s.appended.some((m) => m.text === 'during the outage'));
  s.failUpsert.value = false;
  await run(s, 70_000);
  await again.flushNow();
  assert.equal(s.share.get(t.id)?.access, 'off');
  assert.ok(s.appended.some((m) => m.text === 'during the outage'));
  assert.deepEqual(s.readable.filter((r) => r.slug === slug && r.msg.text === 'during the outage'), []);
  await again.stop();
});
