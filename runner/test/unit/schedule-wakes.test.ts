// scheduleWakes (convex/wakes.ts), what the website's sidebar and the iPhone's
// inbox read instead of every schedule whole (phone:wakes), run against the
// in-memory backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const M5 = 'm5runner0001';
const OLD = 'oldrunner001';
const TOKEN = 'tb_phone';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'phone', expiresAt: Date.now() + 100_000, createdAt: 1 });
  return b;
}

const mirrored = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, text: 'run this', whenText: 'w', threadId: 't1', nextRunAt: '2026-11-09T01:00:00.000Z', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, ...extra });
const wakes = async (s: Awaited<ReturnType<typeof setup>>) => (await call(s.ctx, phone.wakes, { token: TOKEN })) as { scheduleId: string; threadId?: string; nextRunAt?: string }[];

// A runner still mirroring its schedules.json (before API 9) can have a row
// under the same id as an owned schedule on another runner. Its mirror going
// must leave the owned one's wake, as phone:schedules still shows it.
test("a mirrored row going leaves the wake of an owned schedule with its id", async () => {
  const s = await setup();
  await call(s.ctx, sync.setSchedules, { key: OWNER, runnerId: OLD, schedules: [mirrored('s1')] });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: { ...mirrored('s1', { nextRunAt: '2026-11-09T02:00:00.000Z' }), runnerId: M5 } });
  await call(s.ctx, sync.setSchedules, { key: OWNER, runnerId: OLD, schedules: [] });
  assert.deepEqual(await wakes(s), [{ scheduleId: 's1', threadId: 't1', nextRunAt: '2026-11-09T02:00:00.000Z' }]);
});

test('adopting leaves the wake of an owned schedule its mirror shared an id with', async () => {
  const s = await setup();
  await call(s.ctx, sync.setSchedules, { key: OWNER, runnerId: OLD, schedules: [mirrored('s1')] });
  await call(s.ctx, sync.saveSchedule, { key: OWNER, schedule: { ...mirrored('s1', { nextRunAt: '2026-11-09T02:00:00.000Z' }), runnerId: M5 } });
  await call(s.ctx, sync.adoptSchedules, { key: OWNER, runnerId: OLD, schedules: [{ ...mirrored('s1'), runnerId: OLD }] });
  assert.deepEqual(await wakes(s), [{ scheduleId: 's1', threadId: 't1', nextRunAt: '2026-11-09T02:00:00.000Z' }]);
});

test('a mirror going with nothing owned under its id takes its wake', async () => {
  const s = await setup();
  await call(s.ctx, sync.setSchedules, { key: OWNER, runnerId: OLD, schedules: [mirrored('s1')] });
  assert.equal((await wakes(s)).length, 1);
  await call(s.ctx, sync.setSchedules, { key: OWNER, runnerId: OLD, schedules: [] });
  assert.deepEqual(await wakes(s), []);
});
