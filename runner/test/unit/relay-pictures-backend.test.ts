// Pictures sent to another runner's thread from the main Mac (backend API
// 63; docs/protocol.md, "Other runners' threads through the backend"). Mike
// pasted a picture into a new thread on Hetzner Cloud on 8 Nov and the app
// said "Pictures can't go to Hetzner Cloud from this Mac yet." The main Mac's
// runner now uploads each one (the owner's upload URL) and names it in the
// command, which carries a URL for each, as a phone's photos do, so the other
// runner fetches them the same way. These play that through the backend's own
// functions in the in-memory database. Each upload is recorded (relayUploads,
// through /relay/upload, as the phone's are), so one that never went out is
// swept after a day (Codex's review: a lost reply or a runner quitting
// between uploading and queueing left it in storage for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const BRUCE_KEY = 'tbr_bruce';
const M5 = 'm5runner0001';
const BRUCE = 'cb921b2447ea';
const TOKEN = 'phone-token';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: BRUCE, keyHash: await sha256(BRUCE_KEY), name: 'bruce', createdAt: 1 });
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  for (const [runnerId, byOwner] of [[M5, true], [BRUCE, false]] as const) {
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now, ...(byOwner ? { byOwner } : {}) });
  }
  await call(b.ctx, sync.upsertThreads, { key: BRUCE_KEY, threads: [{ threadId: 'B', runnerId: BRUCE, title: 'T', view: 'inbox', needsYou: false }] });
  return b;
}
type S = Awaited<ReturnType<typeof setup>>;

// What the main Mac's runner uploads: a one-use ticket on /relay/upload,
// redeemed as convex/http.ts does once it has stored the file.
async function ownerUpload(s: S, id: string, bytes = 1): Promise<string> {
  const url = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER }));
  assert.equal(url.origin + url.pathname, 'https://site.example/relay/upload');
  assert.equal(await call(s.ctx, relay.redeemRelayUpload, { ticket: url.searchParams.get('ticket'), storageId: s.file(id), bytes }), true);
  return id;
}

test('a send to another runner carries each picture with a URL to fetch it by, in order, and finishing deletes them', async () => {
  const s = await setup();
  const a = await ownerUpload(s, 'pic-a');
  const b = await ownerUpload(s, 'pic-b');
  const commandId = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, threadId: 'B', kind: 'send', args: { text: 'this [Picture 1] like [Picture 2]', images: [a, b] } });
  const c = s.rows('commands').find((r) => r._id === commandId)!;
  // The same shape as a phone's, which every runner already fetches.
  assert.deepEqual(c.args.images, [
    { storageId: a, url: `https://files.example/${a}` },
    { storageId: b, url: `https://files.example/${b}` },
  ]);
  assert.equal(c.args.from, 'mac');
  assert.equal(s.rows('commandFiles').length, 2, 'recorded as on their way');
  // Bruce takes it, fetches them and finishes: they're gone from Convex.
  const pending = (await call(s.ctx, sync.pendingCommands, { key: BRUCE_KEY, runnerId: BRUCE })) as { args: { images: unknown[] } }[];
  assert.equal(pending[0]!.args.images.length, 2);
  await call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId });
  await call(s.ctx, sync.finishCommand, { key: BRUCE_KEY, commandId, ok: true });
  assert.equal(s.hasFile(a), false);
  assert.equal(s.hasFile(b), false);
  assert.equal(s.rows('commandFiles').length, 0);
});

test('a new thread there can be just a picture; a send of nothing at all is still refused', async () => {
  const s = await setup();
  const pic = await ownerUpload(s, 'pic');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, kind: 'create', args: { text: '', images: [pic] } })), 'ok');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, kind: 'create', args: { text: ' ' } })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, kind: 'create', args: { text: '', images: [] } })), 'badArgs');
});

test("a command can't name a file that's gone, in use, a runner key's or a phone's, nor too many", async () => {
  const s = await setup();
  const queue = (images: unknown) => outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, threadId: 'B', kind: 'send', args: { text: 'x', images } }));
  // Gone (or never was).
  assert.equal(await queue(['nothing-here']), 'notFound');
  // A stored file that wasn't uploaded for this: an owner's reply picture uploaded but not attached yet.
  assert.equal(await queue([s.file('bare')]), 'forbidden');
  // Bruce's share picture: finishing would otherwise hand it to the command's runner.
  const ticket = new URL(await call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
  const share = s.file('share');
  assert.equal(await call(s.ctx, sync.redeemUpload, { ticket, storageId: share, bytes: 1 }), true);
  assert.equal(await queue([share]), 'forbidden', "a runner key's upload");
  await call(s.ctx, sync.addShareImage, { key: BRUCE_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: share, mediaType: 'image/png' });
  assert.equal(await queue([share]), 'forbidden');
  // The owner's own reply picture, in use.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'O', runnerId: M5, title: 'T', view: 'inbox', needsYou: false }] });
  const reply = s.file('reply');
  await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'O', seq: 1, path: 'r.png', storageId: reply, mediaType: 'image/png' });
  assert.equal(await queue([reply]), 'forbidden');
  // A phone's photo.
  const url = new URL(await call(s.ctx, phone.imageUploadUrl, { token: TOKEN }));
  const photo = s.file('photo');
  assert.equal(await call(s.ctx, phone.redeemPhoneUpload, { ticket: url.searchParams.get('ticket'), storageId: photo, bytes: 1 }), true);
  assert.equal(await queue([photo]), 'forbidden');
  // Not ids, or more than a message takes.
  assert.equal(await queue('pic'), 'badArgs');
  assert.equal(await queue([42]), 'badArgs');
  assert.equal(await queue(await Promise.all(Array.from({ length: 7 }, (_, i) => ownerUpload(s, `many${i}`)))), 'badArgs');
  // One already on its way in another command: two commands finishing would race for it.
  const once = await ownerUpload(s, 'once');
  assert.equal(await queue([once]), 'ok');
  assert.equal(await queue([once]), 'forbidden');
  // Nothing refused was deleted.
  for (const id of [share, reply, photo, once]) assert.equal(s.hasFile(id), true, id);
});

test('pictures only go with a send or a new thread', async () => {
  const s = await setup();
  const pic = await ownerUpload(s, 'pic');
  const r = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, threadId: 'B', kind: 'interrupt', args: { images: [pic] } });
  assert.equal(s.rows('commands').find((c) => c._id === r)!.args.images, undefined);
  assert.equal(s.rows('commandFiles').length, 0);
});

test("discarding a queue that failed deletes only the owner's loose uploads", async () => {
  const s = await setup();
  const loose = await ownerUpload(s, 'loose');
  const queued = await ownerUpload(s, 'queued');
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, threadId: 'B', kind: 'send', args: { text: 'x', images: [queued] } });
  const ticket = new URL(await call(s.ctx, sync.iconUploadUrl, { key: BRUCE_KEY })).searchParams.get('ticket')!;
  const bruces = s.file('bruces');
  assert.equal(await call(s.ctx, sync.redeemUpload, { ticket, storageId: bruces, bytes: 1 }), true);
  const bare = s.file('bare');
  await call(s.ctx, relay.discardPictures, { key: OWNER, storageIds: [loose, queued, bruces, bare, 'gone'] });
  assert.equal(s.hasFile(bare), true, 'not uploaded for this');
  assert.equal(s.hasFile(loose), false);
  assert.equal(s.hasFile(queued), true, 'still on its way');
  assert.equal(s.hasFile(bruces), true, "a runner key's");
  // Only the main Mac's runner can.
  assert.equal(await outcome(call(s.ctx, relay.discardPictures, { key: BRUCE_KEY, storageIds: [queued] })), 'forbidden');
});

test('the upload URL is the owner\'s, one use, and capped at 10 MB', async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, relay.pictureUploadUrl, { key: BRUCE_KEY })), 'forbidden');
  const ticket = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER })).searchParams.get('ticket');
  assert.equal(await call(s.ctx, relay.relayTicketOk, { ticket }), true);
  assert.equal(await call(s.ctx, relay.redeemRelayUpload, { ticket, storageId: s.file('a'), bytes: 1 }), true);
  assert.equal(await call(s.ctx, relay.relayTicketOk, { ticket }), false, 'used');
  assert.equal(await call(s.ctx, relay.redeemRelayUpload, { ticket, storageId: s.file('b'), bytes: 1 }), false);
  const big = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER })).searchParams.get('ticket');
  assert.equal(await call(s.ctx, relay.redeemRelayUpload, { ticket: big, storageId: s.file('big'), bytes: 10 * 1024 * 1024 + 1 }), false);
  assert.equal(await call(s.ctx, relay.relayTicketOk, { ticket: 'nope' }), false);
});

test('an upload that never went out goes after a day; one in a waiting command stays until that is over', async () => {
  const s = await setup();
  const orphan = await ownerUpload(s, 'orphan');
  const sent = await ownerUpload(s, 'sent');
  const commandId = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BRUCE, threadId: 'B', kind: 'send', args: { text: 'x', images: [sent] } });
  // A ticket whose upload never arrived.
  await call(s.ctx, relay.pictureUploadUrl, { key: OWNER });
  const real = Date.now;
  Date.now = () => real() + DAY + 60_000;
  try {
    for (let i = 0; i < 5; i++) await call(s.ctx, sync.pruneFiles, {});
  } finally {
    Date.now = real;
  }
  assert.equal(s.hasFile(orphan), false);
  assert.equal(s.hasFile(sent), true, 'still on its way to Bruce');
  assert.equal(s.rows('relayUploads').length, 0, 'the records go after a day');
  await call(s.ctx, sync.takeCommand, { key: BRUCE_KEY, commandId });
  await call(s.ctx, sync.finishCommand, { key: BRUCE_KEY, commandId, ok: true });
  assert.equal(s.hasFile(sent), false);
});
