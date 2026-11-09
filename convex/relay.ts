// Other runners' threads read and steered through the backend (API 44,
// docs/protocol.md "Other runners' threads through the backend"): the main
// Mac's runner reads another runner's thread from its messages and threads
// rows, and asks that runner to act on it with a `commands` row, as the
// phone does. The Mac app talks only to its own runner; runners never talk
// to each other. All owner only (runnerAccess.ts ACCESS): a runner key
// can't read another runner's threads or queue work for it.
//
// Read rules (docs/full-convex.md): the live tail is a few rows, older pages
// are read once and kept on the runner, a thread's row is one document, and
// a command's state is one get by id.
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { checkRunnerId, forbidden, pageLimit, runnerAuth, sha256 } from './lib';
import { docBytes } from './runnerAccess';
import { deleteIfUnused, MAX_COMMAND_FILES, MAX_RUNNER_UPLOAD_BYTES, storageInUse } from './sync';

// The live tail: enough for a message or two of tool rows between texts.
export const TAIL_MAX = 15;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
// What a queued command's args may be at most. A send's text is the longest.
const ARGS_MAX_BYTES = 64 * 1024;

const relayRow = v.object({
  seq: v.number(),
  role: v.union(v.literal('user'), v.literal('assistant'), v.literal('tool')),
  text: v.string(),
  origin: v.optional(v.string()),
  toolKind: v.optional(v.string()),
  summary: v.optional(v.boolean()),
  turn: v.optional(v.string()),
  wokeBy: v.optional(v.array(v.object({ kind: v.string(), description: v.string() }))),
  at: v.string(),
});

type Row = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string; origin?: string; toolKind?: string; summary?: boolean; turn?: string; wokeBy?: { kind: string; description: string }[]; at: string };
function toRow(m: Row): Row {
  return {
    seq: m.seq,
    role: m.role,
    text: m.text,
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.toolKind ? { toolKind: m.toolKind } : {}),
    ...(m.summary ? { summary: true } : {}),
    ...(m.turn ? { turn: m.turn } : {}),
    ...(m.wokeBy ? { wokeBy: m.wokeBy } : {}),
    at: m.at,
  };
}

/** The newest rows of a thread, oldest first: the live tail. */
export const remoteTail = query({
  args: { key: v.string(), threadId: v.string(), limit: v.optional(v.number()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, limit }) => {
    await runnerAuth(ctx, key, 'remoteTail');
    const want = pageLimit(limit, TAIL_MAX, TAIL_MAX);
    const rows = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId)).order('desc').take(want + 1);
    return { messages: rows.slice(0, want).reverse().map(toRow), hasMore: rows.length > want };
  },
});

/**
 * A page of a thread's rows, read once: the `limit` before `beforeSeq`, or
 * after `afterSeq` (filling what a tail skipped), or the newest. Oldest first.
 */
export const remoteMessages = query({
  args: { key: v.string(), threadId: v.string(), beforeSeq: v.optional(v.number()), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ messages: v.array(relayRow), hasMore: v.boolean() }),
  handler: async (ctx, { key, threadId, beforeSeq, afterSeq, limit }) => {
    await runnerAuth(ctx, key, 'remoteMessages');
    const want = pageLimit(limit, PAGE_DEFAULT, PAGE_MAX);
    if (afterSeq !== undefined) {
      const rows = await ctx.db.query('messages').withIndex('by_thread_seq', (q) => q.eq('threadId', threadId).gt('seq', afterSeq)).order('asc').take(want + 1);
      return { messages: rows.slice(0, want).map(toRow), hasMore: rows.length > want };
    }
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_thread_seq', (q) => (beforeSeq === undefined ? q.eq('threadId', threadId) : q.eq('threadId', threadId).lt('seq', beforeSeq)))
      .order('desc')
      .take(want + 1);
    return { messages: rows.slice(0, want).reverse().map(toRow), hasMore: rows.length > want };
  },
});

/** One thread's row (its state, open approval and card), live while it's open. Null once it's gone. */
export const remoteThread = query({
  args: { key: v.string(), threadId: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'remoteThread');
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t) return null;
    // The secret card's key stays: the runner seals an answer to it, as the phone does.
    const { _id, _creationTime, pushedAt: _p, pushHeldAt: _h, ...rest } = t;
    return rest;
  },
});

// What a command from the main Mac may carry, kind by kind: only what that
// runner's apply() reads, so nothing else is stored. Each gets `from: "mac"`,
// so a message it sends isn't marked as the phone's (phone.ts never sets it).
// The modes a new thread can start on (runner/src/protocol.ts, PERMISSION_MODES).
const PERMISSION_MODES = ['full', 'ask', 'auto', 'plan'] as const;
const KINDS = ['send', 'respond', 'update', 'create', 'interrupt', 'call', 'share'] as const;
type Kind = (typeof KINDS)[number];
// Methods a `call` may run on the other runner, and nothing else: answers
// with no file contents or tool output in them (step 4 brings those, scrubbed).
export const CALLS = new Set(['files.list']);

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}
function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function commandArgs(kind: Kind, raw: unknown): Record<string, unknown> {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bad = (why: string) => new ConvexError({ kind: 'badArgs', message: why });
  let out: Record<string, unknown>;
  switch (kind) {
    case 'send':
      if (str(a.text) === undefined) throw bad('a send needs text');
      out = pick(a, ['text', 'answers']);
      break;
    case 'respond':
      if (!str(a.approvalId) || !['allow', 'allowAlways', 'deny', 'answered'].includes(String(a.decision))) throw bad('a respond needs approvalId and decision');
      // A secret's answer only ever goes sealed to that runner's key.
      if (a.secret === true && a.decision === 'answered' && !a.sealed) throw bad('a secret goes sealed');
      out = pick(a, ['approvalId', 'decision', 'message', 'answers', 'secret', 'sealed']);
      break;
    case 'update':
      out = pick(a, ['snooze', 'wake', 'archive', 'unarchive', 'markSeen', 'title', 'star']);
      if (Object.keys(out).length !== 1) throw bad('an update changes one thing');
      // How it went, with an archive (API 42), as phone:update takes it.
      if (out.archive === true && ['worked', 'didntWork', 'notNeeded'].includes(String(a.verdict))) out.verdict = a.verdict;
      // An agent on the main Mac archived it (its threadbear tools), so that
      // runner says "archived by an agent", not by Mike.
      if (out.archive === true && a.by === 'agent') out.by = 'agent';
      break;
    case 'create':
      // Pictures alone will do (API 63), as a new thread from this Mac's own composer.
      if (str(a.text) === undefined || (!str(a.text)!.trim() && !(Array.isArray(a.images) && a.images.length))) throw bad('a new thread needs text');
      out = pick(a, ['text', 'cwd', 'accountId', 'model', 'effort']);
      // Left out, the thread gets full access, so every mode is kept and an
      // unknown one refused, never dropped (Daybreak, 7 Nov 2026: Plan first
      // arrived as Full access). Plan first comes as "ask" with plan: true
      // (runner/src/protocol.ts, remoteCreateMode), which a runner from
      // before it reads as Ask.
      if (a.permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(a.permissionMode as never)) throw bad(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
        out.permissionMode = a.permissionMode;
      }
      if (a.plan !== undefined) {
        if (a.plan !== true || a.permissionMode !== 'ask') throw bad('plan: true goes with permissionMode "ask"');
        out.plan = true;
      }
      break;
    case 'interrupt':
      out = {};
      break;
    case 'call':
      if (!CALLS.has(String(a.method))) throw bad(`only ${[...CALLS].join(', ')} can be asked of another runner`);
      // Only what the one allowed call reads: anything else in here would sit in
      // the row, under field names scrubbing skips.
      out = { method: a.method, params: typeof (a.params as { path?: unknown } | undefined)?.path === 'string' ? { path: (a.params as { path: string }).path } : {} };
      break;
    case 'share':
      if (a.access !== 'off' && a.access !== 'link') throw bad('access is "off" or "link"');
      out = pick(a, ['access', 'newLink']);
      break;
  }
  if (docBytes(out) > ARGS_MAX_BYTES) throw bad('too long');
  return out;
}

/**
 * Asks another runner to act on one of its threads (or, for a create or a
 * call, on itself). A thread's command goes to the runner the backend says
 * has the thread, never one the caller names, so it can't be aimed at a
 * runner that would take it for one of its own.
 */
export const queueCommand = mutation({
  args: { key: v.string(), runnerId: v.string(), threadId: v.optional(v.string()), kind: v.union(...KINDS.map((k) => v.literal(k))), args: v.any() },
  returns: v.id('commands'),
  handler: async (ctx, { key, runnerId, threadId, kind, args }) => {
    await runnerAuth(ctx, key, 'queueCommand');
    checkRunnerId(runnerId);
    const runner = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
    if (!runner) throw new ConvexError({ kind: 'notFound', message: 'no such runner' });
    if (threadId !== undefined) {
      const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
      if (!t) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
      if (t.runnerId !== runnerId) throw forbidden("queue that: the thread isn't that runner's");
    } else if (kind !== 'create' && kind !== 'call') {
      throw new ConvexError({ kind: 'badArgs', message: `a ${kind} needs a thread` });
    }
    const images = kind === 'send' || kind === 'create' ? await commandPictures(ctx, (args as { images?: unknown } | null)?.images) : [];
    const commandId = await ctx.db.insert('commands', { runnerId, ...(threadId !== undefined ? { threadId } : {}), kind, args: { ...commandArgs(kind, args), ...(images.length ? { images } : {}), from: 'mac' }, state: 'pending', createdAt: Date.now() });
    // On their way, so nothing deletes them before that runner has fetched
    // them; sync:finishCommand deletes them once it has (as a phone's photos).
    for (const image of images) await ctx.db.insert('commandFiles', { storageId: image.storageId, commandId });
    return commandId;
  },
});

// ------------------------------------------------------------ pictures
// A picture pasted into a message for another runner's thread (API 63). The
// main Mac's runner uploads each one to /relay/upload (pictureUploadUrl),
// which records it (relayUploads), and names it here, and the command
// carries a URL for each, in the shape a phone's photos have, so every
// runner fetches them as it already does for the phone (runner/src/sync.ts
// withPhoneImages). They're in Convex only on their way: finishing the
// command deletes them, and one that never went out goes after a day
// (sync:pruneFiles), whatever happened to the runner meanwhile.

const RELAY_TICKET_MS = 60 * 60_000;

/** A one-use URL on /relay/upload for one picture, at most 10 MB. */
export const pictureUploadUrl = mutation({
  args: { key: v.string() },
  returns: v.string(),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'pictureUploadUrl');
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new ConvexError({ kind: 'config', message: 'CONVEX_SITE_URL is not set' });
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await ctx.db.insert('relayUploads', { ticketHash: await sha256(ticket), issuedAt: Date.now() });
    return `${site.replace(/\/+$/, '')}/relay/upload?ticket=${ticket}`;
  },
});

// Unused and under an hour old.
async function liveRelayTicket(ctx: QueryCtx | MutationCtx, ticket: string) {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  const hash = await sha256(ticket);
  const row = await ctx.db.query('relayUploads').withIndex('by_hash', (q) => q.eq('ticketHash', hash)).first();
  return row && !row.usedAt && row.issuedAt > Date.now() - RELAY_TICKET_MS ? row : null;
}

// For /relay/upload, before it stores anything.
export const relayTicketOk = internalQuery({
  args: { ticket: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { ticket }) => (await liveRelayTicket(ctx, ticket)) !== null,
});

// The stored file is this upload's. False (the route then deletes the file):
// a dead or used ticket, or a file over the cap. Spent whatever happens.
export const redeemRelayUpload = internalMutation({
  args: { ticket: v.string(), storageId: v.id('_storage'), bytes: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { ticket, storageId, bytes }) => {
    const row = await liveRelayTicket(ctx, ticket);
    if (!row) return false;
    const ok = bytes >= 0 && bytes <= MAX_RUNNER_UPLOAD_BYTES;
    await ctx.db.patch(row._id, { usedAt: Date.now(), ...(ok ? { storageId } : {}) });
    return ok;
  },
});

// Each named file: one uploaded for this (relayUploads; a runner key's,
// a phone's or any other stored file never is), and named by nothing else,
// another command included: finishing would delete it from under that.
async function commandPictures(ctx: MutationCtx, raw: unknown): Promise<{ storageId: Id<'_storage'>; url: string }[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw new ConvexError({ kind: 'badArgs', message: 'images are storage ids' });
  if (raw.length > MAX_COMMAND_FILES) throw new ConvexError({ kind: 'badArgs', message: `at most ${MAX_COMMAND_FILES} pictures in a message to another Mac` });
  const out: { storageId: Id<'_storage'>; url: string }[] = [];
  for (const id of raw as Id<'_storage'>[]) {
    if (out.some((o) => o.storageId === id)) throw new ConvexError({ kind: 'badArgs', message: 'the same picture twice' });
    const url = (await stored(ctx, id)) ? await ctx.storage.getUrl(id) : null;
    if (!url) throw new ConvexError({ kind: 'notFound', message: 'that picture has gone' });
    if (!(await isRelayUpload(ctx, id)) || (await storageInUse(ctx, id))) throw forbidden('send a stored file that is something else');
    out.push({ storageId: id, url });
  }
  return out;
}

// Whether a file is there; an id that isn't one at all (Convex throws on it) isn't.
async function stored(ctx: MutationCtx, id: Id<'_storage'>): Promise<boolean> {
  try {
    return (await ctx.db.system.get(id)) !== null;
  } catch {
    return false;
  }
}

async function isRelayUpload(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<boolean> {
  return (await ctx.db.query('relayUploads').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first()) !== null;
}

/**
 * Pictures the main Mac's runner uploaded for a command that then wasn't
 * queued: deleted, but only ones of its own that nothing names (one that
 * did get queued stays until its command is over).
 */
export const discardPictures = mutation({
  args: { key: v.string(), storageIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, storageIds }) => {
    await runnerAuth(ctx, key, 'discardPictures');
    for (const id of storageIds.slice(0, MAX_COMMAND_FILES) as Id<'_storage'>[]) {
      if (!(await stored(ctx, id)) || !(await isRelayUpload(ctx, id))) continue;
      await deleteIfUnused(ctx, id);
    }
    return null;
  },
});

/** Where a command the main Mac queued has got to, one get by id: watched until it's done or failed. */
export const commandState = query({
  args: { key: v.string(), commandId: v.id('commands') },
  returns: v.union(
    v.null(),
    v.object({ state: v.union(v.literal('pending'), v.literal('taken'), v.literal('done'), v.literal('failed')), note: v.optional(v.string()), threadId: v.optional(v.string()), result: v.optional(v.any()) }),
  ),
  handler: async (ctx, { key, commandId }) => {
    await runnerAuth(ctx, key, 'commandState');
    const c = await ctx.db.get(commandId);
    if (!c) return null;
    let result: unknown;
    try {
      result = c.result !== undefined ? JSON.parse(c.result) : undefined;
    } catch {
      result = undefined;
    }
    return { state: c.state, ...(c.note ? { note: c.note } : {}), ...(c.resultThreadId ? { threadId: c.resultThreadId } : {}), ...(result !== undefined ? { result } : {}) };
  },
});

/** Another runner's logins, with their models, for the new-thread pickers on the main Mac. */
export const remoteAccounts = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, { key, runnerId }) => {
    await runnerAuth(ctx, key, 'remoteAccounts');
    const out = [];
    for (const a of await ctx.db.query('accounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).take(50)) {
      const { _id, _creationTime, usage: _u, ...rest } = a;
      out.push(rest);
    }
    return out;
  },
});

// ------------------------------------------------------------ requests
// A runner on a runner key asking for a new thread on another runner
// (docs/protocol.md, "Asking another runner"; schema.ts runnerRequests). It
// files the request here and shows a card in its own thread; the main Mac's
// app reads the request back through its runner, shows Mike all of it, and
// on Allow its runner (the owner key) starts the thread and marks the row.
// The asking runner never queues anything for another runner: the most a
// tampered one can do is put a card in front of Mike.

const REQUEST_TEXT_MAX = 32 * 1024;
const REQUEST_FIELD_MAX = 1024;
// Waiting at once, per runner. A card waits at most an hour (the runner's
// timer), so a few is plenty, and one older than two hours is dead (its
// runner restarted, or its close never arrived) and doesn't count.
const REQUESTS_PENDING_MAX = 5;
const PENDING_LIVE_MS = 2 * 60 * 60 * 1000;
// Kept at most, per runner, whatever their state, so filing and closing
// over and over can't fill the deployment.
const REQUESTS_KEPT_MAX = 50;
// Kept a week, for "what did the cloud ask for", then swept as the runner files more.
const REQUEST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
// The asking thread's id goes into the first line the main Mac's runner
// writes on the new thread, so nothing but an id's characters.
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = ['pending', 'claimed', 'allowed', 'denied', 'closed'] as const;
const stateV = v.union(...STATES.map((x) => v.literal(x)));

const requestFields = {
  text: v.string(),
  title: v.optional(v.string()),
  cwd: v.optional(v.string()),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  why: v.optional(v.string()),
};

const requestOut = v.object({
  // The row itself: a claim names it, so a request filed again under the
  // same id (after the first was swept) is never the one claimed.
  docId: v.string(),
  requestId: v.string(),
  runnerId: v.string(),
  runnerName: v.string(),
  threadId: v.string(),
  target: v.string(),
  ...requestFields,
  createdAt: v.number(),
  state: stateV,
  result: v.optional(v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() })),
  decidedAt: v.optional(v.number()),
});

async function runnerNameOf(ctx: { db: any }, runnerId: string): Promise<string> {
  const r = await ctx.db.query('runners').withIndex('by_runnerId', (q: any) => q.eq('runnerId', runnerId)).unique();
  return (r?.name as string | undefined) || runnerId;
}

export const fileRequest = mutation({
  args: { key: v.string(), requestId: v.string(), threadId: v.string(), target: v.string(), request: v.object(requestFields) },
  returns: v.null(),
  handler: async (ctx, { key, requestId, threadId, target, request }) => {
    const caller = await runnerAuth(ctx, key, 'fileRequest');
    // The owner key starts threads anywhere itself; it never needs to ask.
    if (caller.owner) throw new ConvexError({ kind: 'badArgs', message: "The main Mac's runner starts threads on other runners itself." });
    const bad = (why: string) => new ConvexError({ kind: 'badArgs', message: why });
    if (!REQUEST_ID.test(requestId)) throw bad('a request id is 8 to 64 letters, digits or dashes');
    if (!request.text.trim()) throw bad('a new thread needs text');
    if (docBytes(request.text) > REQUEST_TEXT_MAX) throw bad(`the brief is over ${REQUEST_TEXT_MAX} bytes`);
    for (const f of ['title', 'cwd', 'model', 'effort', 'permissionMode', 'why'] as const) {
      if (request[f] !== undefined && docBytes(request[f]) > REQUEST_FIELD_MAX) throw bad(`${f} is too long`);
    }
    if (!target.trim() || docBytes(target) > 128) throw bad('name the runner to start it on');
    if (!THREAD_ID.test(threadId)) throw bad("that isn't a thread id");
    // Asked from one of its own threads, so the card and its answer are its own.
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!t || t.runnerId !== caller.runnerId) throw forbidden("ask for that: the thread isn't this runner's");
    if (await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first()) throw bad('that request id is taken');
    const now = Date.now();
    // Oldest first: what's past a week goes, and then the oldest until
    // there's room, except one the main Mac is starting now.
    const rows = await ctx.db.query('runnerRequests').withIndex('by_runnerId', (q) => q.eq('runnerId', caller.runnerId)).take(REQUESTS_KEPT_MAX + 10);
    let kept = rows.length;
    for (const r of rows) {
      const old = now - r.createdAt > REQUEST_KEEP_MS;
      if (!old && kept < REQUESTS_KEPT_MAX) break;
      if (!old && r.state === 'claimed') continue;
      await ctx.db.delete(r._id);
      kept--;
    }
    if (kept >= REQUESTS_KEPT_MAX) throw new ConvexError({ kind: 'tooMany', message: `A runner key may keep at most ${REQUESTS_KEPT_MAX} requests` });
    const waiting = await ctx.db.query('runnerRequests').withIndex('by_runner_state', (q) => q.eq('runnerId', caller.runnerId).eq('state', 'pending')).take(REQUESTS_KEPT_MAX);
    const pending = waiting.filter((r) => now - r.createdAt < PENDING_LIVE_MS).length;
    if (pending >= REQUESTS_PENDING_MAX) throw new ConvexError({ kind: 'tooMany', message: `A runner key may have at most ${REQUESTS_PENDING_MAX} requests waiting` });
    await ctx.db.insert('runnerRequests', { requestId, runnerId: caller.runnerId, threadId, target, ...request, createdAt: now, state: 'pending' });
    return null;
  },
});

/** A request as it was filed, and how it went: the owner's (any) or the runner key's own. */
export const runnerRequest = query({
  args: { key: v.string(), requestId: v.string() },
  returns: v.union(v.null(), requestOut),
  handler: async (ctx, { key, requestId }) => {
    const caller = await runnerAuth(ctx, key, 'runnerRequest');
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    if (!r || (!caller.owner && r.runnerId !== caller.runnerId)) return null;
    const { _id, _creationTime, ...rest } = r;
    return { ...rest, docId: String(_id), runnerName: await runnerNameOf(ctx, r.runnerId) };
  },
});

// What the main Mac's runner may move a request to, from where: it claims
// one before starting it (so a retry, or another click, can't start a
// second), then marks it allowed with where it started; it hands a claim
// back only when starting failed here; it says no only to a pending one.
const MOVES: Record<string, string[]> = { claimed: ['pending'], allowed: ['claimed'], pending: ['claimed'], denied: ['pending'] };

/** Mike's answer, recorded by the main Mac's runner as it starts the thread (or he said no). */
export const decideRequest = mutation({
  args: {
    key: v.string(),
    requestId: v.string(),
    state: v.union(v.literal('claimed'), v.literal('allowed'), v.literal('pending'), v.literal('denied')),
    // The row as read (runnerRequest's docId): another row under this id isn't it.
    docId: v.string(),
    result: v.optional(v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, { key, requestId, state, docId, result }) => {
    await runnerAuth(ctx, key, 'decideRequest');
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    if (!r || String(r._id) !== docId) throw new ConvexError({ kind: 'notFound', message: 'no such request' });
    if (!MOVES[state]!.includes(r.state)) throw new ConvexError({ kind: 'badArgs', message: `that request is ${r.state}` });
    if (state === 'allowed' && !result) throw new ConvexError({ kind: 'badArgs', message: 'an allowed request says where it started' });
    await ctx.db.patch(r._id, { state, ...(state === 'allowed' && result ? { result } : {}), decidedAt: Date.now() });
    return null;
  },
});

/** The asking runner gave up on one of its own requests (its card closed without it starting). */
export const closeRequest = mutation({
  args: { key: v.string(), requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, requestId }) => {
    const caller = await runnerAuth(ctx, key, 'closeRequest');
    const r = await ctx.db.query('runnerRequests').withIndex('by_requestId', (q) => q.eq('requestId', requestId)).first();
    if (!r || (!caller.owner && r.runnerId !== caller.runnerId)) throw new ConvexError({ kind: 'notFound', message: 'no such request' });
    // Only one nobody has started: a claimed one may be starting now.
    if (r.state === 'pending') await ctx.db.patch(r._id, { state: 'closed', decidedAt: Date.now() });
    return null;
  },
});
