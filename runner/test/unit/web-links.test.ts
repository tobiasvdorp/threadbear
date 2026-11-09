import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeDestinations, findStep, readLink } from '../../../web/src/thread-links.ts';

test('escapes the destinations agents write, so they parse as links', () => {
  // The same text Mike saw raw on the phone, 1 Nov; the website had it too.
  assert.equal(
    escapeDestinations("that's [landed on main](work:Commit, land, retire the old simulator) as `ec865ff`."),
    "that's [landed on main](work:Commit%2C%20land%2C%20retire%20the%20old%20simulator) as `ec865ff`.",
  );
  assert.equal(escapeDestinations('[a](thread:a1b2c3d4)'), '[a](thread:a1b2c3d4)');
  assert.equal(escapeDestinations('[done](work:npm%20test)'), '[done](work:npm%20test)');
  assert.equal(escapeDestinations('[a](work:npm test (unit)) next'), '[a](work:npm%20test%20(unit)) next');
  assert.equal(escapeDestinations('[odd](work:100% done)'), '[odd](work:100%25%20done)');
});

test('leaves everything else alone', () => {
  const web = '[x](https://a.b/c) and [y](/a/b.md)';
  assert.equal(escapeDestinations(web), web);
  assert.equal(
    escapeDestinations('Write `[a](work:npm test)` like that, [b](work:npm test)'),
    'Write `[a](work:npm test)` like that, [b](work:npm%20test)',
  );
  assert.equal(
    escapeDestinations('`x` [a](work:a b) `[b](work:a b)` [c](work:a b) `y`'),
    '`x` [a](work:a%20b) `[b](work:a b)` [c](work:a%20b) `y`',
  );
  const fenced = '```\n[a](work:npm test)\n```\n[b](work:npm test)';
  assert.equal(escapeDestinations(fenced), '```\n[a](work:npm test)\n```\n[b](work:npm%20test)');
});

test('reads each kind of link', () => {
  assert.deepEqual(readLink('work:npm%20test'), { kind: 'step', quote: 'npm test' });
  assert.deepEqual(readLink('thread:a1b2c3d4'), { kind: 'thread', id: 'a1b2c3d4' });
  assert.deepEqual(readLink('review:abc'), { kind: 'review' });
  assert.equal(readLink('https://a.b'), undefined);
  assert.equal(readLink('/a/b.md'), undefined);
  assert.equal(readLink('work:'), undefined);
});

const rows = [
  { seq: 1, role: 'user' as const, text: 'First' },
  { seq: 2, role: 'tool' as const, text: 'Run the tests' },
  { seq: 3, role: 'assistant' as const, text: 'All done.', summary: true },
  { seq: 4, role: 'user' as const, text: 'Second' },
  { seq: 5, role: 'tool' as const, text: 'Run the tests' },
  { seq: 6, role: 'assistant' as const, text: 'Now the risky part.' },
  { seq: 7, role: 'tool' as const, text: 'Commit, land, retire the old simulator' },
  { seq: 8, role: 'tool' as const, text: 'Edited ~/dev/a.tsx' },
  { seq: 9, role: 'assistant' as const, text: '- [Landed](work:Commit, land)', summary: true },
];

test('a work link finds its step in its own turn', () => {
  assert.equal(findStep('commit,  LAND', 9, rows), 7);
  assert.equal(findStep('Run the tests', 9, rows), 5);
  assert.equal(findStep('Run the tests', 3, rows), 2);
  assert.equal(findStep('risky part', 9, rows), 6);
  assert.equal(findStep('/Users/mike/dev/a.tsx', 9, rows), 8);
});

test('words found nowhere in the turn find nothing', () => {
  assert.equal(findStep('npm run nothing', 9, rows), undefined);
  assert.equal(findStep('Landed', 9, rows), undefined);
  assert.equal(findStep('Edited', 3, rows), undefined);
  assert.equal(findStep('Run the tests', 99, rows), undefined);
});

// CPU time, not wall time: the machine running the tests may be busy.
function cpuMs(work: () => void): number {
  const start = process.cpuUsage();
  work();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

test('a work link that quotes a closed link finds nothing, an unclosed one is just words', () => {
  const own = [
    { seq: 1, role: 'user' as const, text: 'Go' },
    { seq: 2, role: 'assistant' as const, text: 'see [x](work:secret words) then ](work:open tail' },
    { seq: 3, role: 'assistant' as const, text: '[a](work:secret words) [b](work:open tail)' },
  ];
  assert.equal(findStep('secret words', 3, own), undefined);
  assert.equal(findStep('open tail', 3, own), 2);
  assert.equal(findStep('open tail', 3, own), 2, 'the same answer the second time');
});

// Daybreak, 8 Nov: two rows of unclosed `](work:` and a summary of 650 links,
// each under the mirror's 8,000 characters, took 15 seconds to render.
test('crafted rows of unclosed work links render quickly', () => {
  const crafted = () => [
    { seq: 1, role: 'user' as const, text: 'Go' },
    { seq: 2, role: 'assistant' as const, text: '](work:'.repeat(1140) },
    { seq: 3, role: 'assistant' as const, text: '](work:'.repeat(1140) },
    { seq: 4, role: 'assistant' as const, text: '[x](work:z) '.repeat(650) },
  ];
  // As written: 650 links to the same words.
  let page = crafted();
  const same = cpuMs(() => {
    escapeDestinations(page[3]!.text);
    for (let i = 0; i < 650; i++) assert.equal(findStep('z', 4, page), undefined);
  });
  assert.ok(same < 100, `650 links took ${same.toFixed(0)} ms`);
  // And 650 different ones, so remembering answers isn't what saves it.
  page = crafted();
  const different = cpuMs(() => {
    for (let i = 0; i < 650; i++) assert.equal(findStep(`z${i}`, 4, page), undefined);
  });
  assert.ok(different < 100, `650 different links took ${different.toFixed(0)} ms`);
});

test('one long line of unclosed work links is read in one pass', () => {
  // Ten times the mirror's limit, to show the time grows with the length, not its square.
  const page = [
    { seq: 1, role: 'user' as const, text: 'Go' },
    { seq: 2, role: 'assistant' as const, text: '](work:'.repeat(11_400) },
    { seq: 3, role: 'assistant' as const, text: '[x](work:z)' },
  ];
  const ms = cpuMs(() => assert.equal(findStep('z', 3, page), undefined));
  assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
});

test('a page full of long rows and links has a bounded cost', () => {
  // The worst a page of 80 rows can be: 40 rows of the 8,000 characters the
  // mirror keeps that every search reads to the end, then 40 messages of as
  // many different links as fit.
  const page: { seq: number; role: 'user' | 'assistant' | 'tool'; text: string }[] = [{ seq: 0, role: 'user', text: 'Go' }];
  for (let i = 1; i <= 40; i++) page.push({ seq: i, role: 'tool', text: 'z '.repeat(4000) });
  for (let i = 41; i <= 80; i++) page.push({ seq: i, role: 'assistant', text: '' });
  let found = 0;
  const ms = cpuMs(() => {
    for (let m = 41; m <= 80; m++) for (let l = 0; l < 700; l++) if (findStep(`z q${m}-${l}`, m, page) !== undefined) found++;
  });
  assert.equal(found, 0);
  assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
  // Links that do find their step still do, on a fresh page.
  assert.equal(findStep('Run the tests', 9, [...rows]), 5);
});

test('a long link destination costs no more than a short one', () => {
  // Codex, reviewing the fix: `[x][r]` hundreds of times with one reference
  // `[r]: work:zzzz...` made every link decode and normalise 4,000 characters.
  const long = 'z'.repeat(4000);
  assert.deepEqual(readLink(`work:${long}`), { kind: 'plain' });
  assert.deepEqual(readLink(`thread:${long}`), { kind: 'plain' });
  const page = [
    { seq: 1, role: 'user' as const, text: 'Go' },
    { seq: 2, role: 'tool' as const, text: long },
    { seq: 3, role: 'assistant' as const, text: '' },
  ];
  assert.equal(findStep(long, 3, page), undefined);
  const href = `work:${long}`;
  const ms = cpuMs(() => {
    for (let i = 0; i < 80 * 660; i++) {
      readLink(href);
      findStep(long, 3, page);
    }
  });
  assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
  // Ordinary ones still read.
  assert.deepEqual(readLink(`work:${'a%20'.repeat(200)}`), { kind: 'step', quote: 'a '.repeat(200).trim() });
});

test('thousands of links to one long destination cost little more than the links', () => {
  // Codex, second look: 79 rows of `[r] ` 1,600 times with `[r]: work:` and a
  // destination just under the limit, so each link was decoded and normalised.
  const body = 'x%20'.repeat(249);
  const page = [{ seq: 0, role: 'user' as const, text: 'Go' }, { seq: 1, role: 'tool' as const, text: 'Ran it' }];
  for (let i = 2; i <= 80; i++) page.push({ seq: i, role: 'assistant' as const, text: `${'[r] '.repeat(1600)}\n\n[r]: work:${body}` } as never);
  // A fresh copy of the destination for every link, as a renderer may hand over.
  const hrefs = Array.from({ length: 1600 }, (_, i) => `work:${body}`.split('').join(''));
  const ms = cpuMs(() => {
    for (let m = 2; m <= 80; m++) {
      for (const href of hrefs) {
        readLink(href);
        const link = readLink(href);
        if (link?.kind === 'step') findStep(link.quote, m, page);
      }
    }
  });
  assert.ok(ms < 250, `took ${ms.toFixed(0)} ms for 126,400 links`);
});
