// Links from a message back into the thread (docs/protocol.md, "Links into the
// thread"), as the Mac's WorkLinks and the phone's ThreadLinks read them:
// `work:<words>` quotes a step in the turn's working, `thread:<id>` is another
// thread and `review:<id>` a design review, which only the Mac can open.
// `button:<id>` is a reply button (docs/protocol.md, "Reply buttons"). `plain`
// is one of those too long to read, shown as its words.

export type LinkTarget = { kind: 'step'; quote: string } | { kind: 'thread'; id: string } | { kind: 'review' } | { kind: 'button'; id: string } | { kind: 'plain' };
type Row = { seq: number; role: 'user' | 'assistant' | 'tool'; text: string; summary?: boolean };

// The markdown with work: and thread: destinations escaped, as agents write
// `[tests pass](work:npm test)` and a destination with a space isn't a link to
// the parser: the page showed the whole thing as raw text. Code stays as
// written, as it's only being talked about.
export function escapeDestinations(markdown: string): string {
  if (!markdown.includes('](work:') && !markdown.includes('](thread:')) return markdown;
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.startsWith(fence)) fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return escapeLine(line);
    })
    .join('\n');
}

function escapeLine(line: string): string {
  const spans = [...line.matchAll(/`+[^`]*`+/g)].map((m) => [m.index, m.index + m[0].length] as const);
  // One level of brackets inside, for `work:npm test (unit)`.
  // Both come in order, so one pass over the spans does for every link
  // (a `some` per link was links times spans on a long line).
  let next = 0;
  return line.replace(/\]\((work|thread):((?:[^()]|\([^()]*\))*)\)/g, (whole, scheme: string, body: string, at: number) => {
    while (next < spans.length && spans[next]![1] <= at) next++;
    if (next < spans.length && spans[next]![0] < at + whole.length) return whole;
    return `](${scheme}:${encodeURIComponent(decoded(body))})`;
  });
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // "100% done" isn't escaped, just a percent sign.
  }
}

// What a link means, or undefined for anywhere else (a web page).
//
// Every link on the page is read here as it renders (twice), and one
// reference definition (`[r]: work:...`) can stand behind thousands of `[r]`
// links, so each destination is read once and remembered, and one too long
// for any step's words or id is shown as plain text without decoding it.
export function readLink(href: string): LinkTarget | undefined {
  // Only what's worth keeping: a web address or an over-long one is quick to
  // tell apart again, and this way the memory held stays within 10,000 short ones.
  if (href.length > MAX_LINK + 10 || !/^(work|thread|review|button):/i.test(href)) return read(href);
  const known = links.get(href);
  if (known !== undefined) return known ?? undefined;
  const target = read(href);
  if (links.size >= 10_000) links.clear();
  links.set(href, target ?? null);
  return target;
}

const links = new Map<string, LinkTarget | null>();

function read(href: string): LinkTarget | undefined {
  const match = /^(work|thread|review|button):/i.exec(href);
  if (!match) return undefined;
  const body = href.slice(match[0].length);
  if (body.length > MAX_LINK) return { kind: 'plain' };
  const words = decoded(body).trim();
  switch (match[1]!.toLowerCase()) {
    case 'work':
      return words ? { kind: 'step', quote: words } : undefined;
    case 'thread':
      return words ? { kind: 'thread', id: words } : undefined;
    case 'button':
      return words ? { kind: 'button', id: words } : undefined;
    default:
      return { kind: 'review' };
  }
}

// The step a work: link in message `seq` means: the latest in that message's
// turn with the words in it, as the Mac picks it. Undefined when none has,
// which a step's one line makes likelier than on the Mac (a command with a
// description comes as only the description).
//
// Every work link in every message on the page calls this while rendering, so
// a transcript (whose words a model, and so a cloned repo, can steer) must not
// be able to make it slow (Daybreak, 8 Nov: a few crafted rows froze the page
// for 15 seconds). Each row's text is made searchable once, answers are
// remembered, and one page of rows gets SCAN_BUDGET characters of searching
// in all; past that a link reads as plain text, as one that finds nothing does.
export function findStep(quote: string, seq: number, rows: readonly Row[]): number | undefined {
  if (quote.length > MAX_LINK) return undefined;
  // Remembered by the words as given, before any work on them.
  const page = pageFor(rows);
  let found = page.found.get(seq);
  if (!found) page.found.set(seq, (found = new Map()));
  if (found.has(quote)) return found.get(quote);
  const step = search(normal(quote), seq, rows, page);
  found.set(quote, step);
  return step;
}

function search(q: string, seq: number, rows: readonly Row[], page: Page): number | undefined {
  if (!q) return undefined;
  let step: number | undefined;
  const from = page.index.get(seq);
  for (let i = (from ?? 0) - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.role === 'user') break;
    const text = searchable(row);
    if (text === undefined) continue;
    page.left -= text.length;
    if (page.left < 0) break;
    if (text.includes(q)) {
      step = row.seq;
      break;
    }
  }
  return step;
}

export const SCAN_BUDGET = 2_000_000;
// The longest link destination (escaped, so three characters for some) read
// as a step's words or an id. Keeps each link's own cost small, whatever the
// page.
export const MAX_LINK = 1_000;

type Page = { index: Map<number, number>; found: Map<number, Map<string, number | undefined>>; left: number };
const pages = new WeakMap<readonly Row[], Page>();
const texts = new WeakMap<Row, string | null>();

// One page of rows (the same array while it's on screen) and what's been
// worked out about it.
function pageFor(rows: readonly Row[]): Page {
  let page = pages.get(rows);
  if (!page) {
    page = { index: new Map(rows.map((r, i) => [r.seq, i])), found: new Map(), left: SCAN_BUDGET };
    pages.set(rows, page);
  }
  return page;
}

// What a row's words are searched as, or undefined for a summary: a line that
// links to a step isn't the step, nor is the summary.
function searchable(row: Row): string | undefined {
  let text = texts.get(row);
  if (text === undefined) {
    text = row.role === 'assistant' && row.summary ? null : normal(row.role === 'tool' ? row.text : withoutWorkLinks(row.text));
    texts.set(row, text);
  }
  return text ?? undefined;
}

// `](work:...)` taken out of a message's own text. A destination with no `)`
// before the line ends is left as it is, and the match takes the rest of that
// line with it, so nothing is scanned twice: `/\]\(work:[^)\n]*\)/g` tried
// again from every later `](work:` on the line, quadratic in its length.
function withoutWorkLinks(text: string): string {
  return text.replace(/\]\(work:[^)\n]*(\))?/g, (whole, closed: string | undefined) => (closed ? ']' : whole));
}

// Lowercase, one space, and home as the runner's step lines write it, so
// `/Users/mike/a.md` finds "Edited ~/a.md".
function normal(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/g, '~')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
