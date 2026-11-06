// Text a repo or a model writes, read in time linear in its length (Gautam's
// security scan, 6 Nov 2026: F9, F24, F25, F26, F27, F29, F30, and the same
// shapes elsewhere). Each finding has tests of what the code gave before on
// ordinary input, which must not change, then its pathological input at a
// size the old regex took a second or more on (on tinker-desk's M2), which
// must now take well under 100 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { parseEnvValue, readEnvValue } from '../../src/patches.ts';
import { FolderCache } from '../../src/folder-cache.ts';
import { KnownValues, looksRandom, parseEnvFile, valuesOfVariable } from '../../src/secret-values.ts';
import { innerCommand, stripLeakedToolCall } from '../../src/adapters/codex/normalize.ts';
import { needsFromText, replyWithoutRepeat, splitReplySection } from '../../src/needs.ts';
import { linkItem, linksIn, pushedBranches } from '../../src/highlights.ts';
import { mainCheckout } from '../../src/librarian.ts';
import { markdownImages } from '../../src/share-images.ts';
import { cleanTitle as notionTitle, findSource, pickView, readSchema } from '../../src/notion-tasks.ts';
import { pageHasScripts } from '../../src/runner/highlights.ts';
import { cleanTitle } from '../../src/runner.ts';

// Characters the Write tool and editors like to turn into the real thing.
const LS = String.fromCharCode(0x2028);
const IDEO_SPACE = String.fromCharCode(0x3000);

// Backtracking spends CPU; waiting for another process or the disk does not.
// The old versions took a second or more of CPU on each of these.
function fast<T>(what: string, fn: () => T): T {
  const cpu = process.cpuUsage();
  const out = fn();
  const { user, system } = process.cpuUsage(cpu);
  const ms = (user + system) / 1000;
  assert.ok(ms < 100, `${what} took ${Math.round(ms)} ms of CPU`);
  return out;
}

// The limits, as numbers: these tests run against the old code too, which
// has no such names.
const MAX_TEXT_BYTES = 64 * 1024; // folder-cache.ts
const MAX_URL = 2000; // highlights.ts

const noFiles = { cwd: '/', home: '/Users/x', isFile: () => false };

// ------------------------------------------------------------------ F9

test('F9: a .env value for the Convex panel reads as before', () => {
  const v = (text: string) => parseEnvValue(text, 'CONVEX_DEPLOYMENT');
  assert.equal(v('CONVEX_DEPLOYMENT=dev:abc # team: mike, project: walkies'), 'dev:abc');
  assert.equal(v('CONVEX_DEPLOYMENT=dev:abc#not-a-comment'), 'dev:abc#not-a-comment');
  assert.equal(v('  export CONVEX_DEPLOYMENT =\tdev:abc  '), 'dev:abc');
  assert.equal(v('CONVEX_DEPLOYMENT="dev:quoted # kept"'), 'dev:quoted # kept');
  assert.equal(v('CONVEX_DEPLOYMENT="dev:x" # c'), '"dev:x"');
  assert.equal(v('CONVEX_DEPLOYMENT= # only a comment'), '# only a comment');
  assert.equal(v('CONVEX_DEPLOYMENT=a \t# c # d'), 'a');
  assert.equal(v('CONVEX_DEPLOYMENT='), '');
  assert.equal(v('# CONVEX_DEPLOYMENT=dev:no\r\nCONVEX_DEPLOYMENT=dev:yes\r\n'), 'dev:yes');
  assert.equal(v('CONVEX_DEPLOYMENT=a\rb'), undefined, 'a lone \\r left the line unread');
  assert.equal(v('CONVEX_DEPLOYMENT=a #b\rc'), undefined);
  assert.equal(v('OTHER=1\nCONVEX_DEPLOYMENT=first\nCONVEX_DEPLOYMENT=second'), 'first');
});

test('F9: a .env value of a long run of spaces is read in linear time', () => {
  for (const ws of [' ', '\t', IDEO_SPACE]) {
    assert.equal(fast('parseEnvValue', () => parseEnvValue(`CONVEX_DEPLOYMENT=dev:a${ws.repeat(40_000)}b`, 'CONVEX_DEPLOYMENT')), `dev:a${ws.repeat(40_000)}b`);
    assert.equal(fast('parseEnvValue', () => parseEnvValue(`CONVEX_DEPLOYMENT=${ws.repeat(40_000)}x${LS}y`, 'CONVEX_DEPLOYMENT')), undefined);
  }
});

test('F9: a .env over 64 KB is left out of the panels, unread', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.env.local'), `CONVEX_DEPLOYMENT=dev:big-one\n${'#'.repeat(MAX_TEXT_BYTES)}\n`);
  fs.writeFileSync(path.join(dir, '.env'), 'CONVEX_DEPLOYMENT=dev:small-one\n');
  assert.equal(fast('readEnvValue', () => readEnvValue(dir, 'CONVEX_DEPLOYMENT', new FolderCache())), 'dev:small-one');
  fs.writeFileSync(path.join(dir, '.env.local'), `CONVEX_DEPLOYMENT=dev:just-fits${' '.repeat(MAX_TEXT_BYTES - 40)}\n`);
  assert.equal(readEnvValue(dir, 'CONVEX_DEPLOYMENT', new FolderCache()), 'dev:just-fits');
});

test('F9: the panels read a big .env asynchronously the same way', async () => {
  const dir = tmpDir();
  const file = path.join(dir, '.env.local');
  fs.writeFileSync(file, 'X'.repeat(MAX_TEXT_BYTES + 1));
  const cache = new FolderCache();
  await cache.warmTexts([file]);
  assert.equal(cache.text(file), undefined);
});

// ----------------------------------------------------------------- F25

test('F25: .env files for the secret mask parse as before', () => {
  const text = [
    '# a comment',
    'PLAIN=abc # note',
    'HASH=abc#kept',
    'export QUOTED="two words" # c',
    "SINGLE='x' ",
    'ESCAPED="a \\" b"',
    'MULTI="line one',
    'line two"',
    'NEVER="opened here',
    'bad line',
    "AFTER='one",
    "two' # c",
    'LONE=a\rb',
    'TAB=\tv',
    'X.Y-Z=1',
  ].join('\n');
  assert.deepEqual(parseEnvFile(text), [
    { name: 'PLAIN', value: 'abc' },
    { name: 'HASH', value: 'abc#kept' },
    { name: 'QUOTED', value: 'two words' },
    { name: 'SINGLE', value: 'x' },
    { name: 'ESCAPED', value: 'a \\" b' },
    { name: 'MULTI', value: 'line one\nline two' },
    { name: 'NEVER', value: 'opened here' },
    { name: 'AFTER', value: 'one\ntwo' },
    { name: 'TAB', value: 'v' },
    { name: 'X.Y-Z', value: '1' },
  ]);
  // A quote that never closes takes its own line, and the lines after it
  // are read as lines of their own.
  assert.deepEqual(parseEnvFile('A="x\nB=2\nC="y'), [
    { name: 'A', value: 'x' },
    { name: 'B', value: '2' },
    { name: 'C', value: 'y' },
  ]);
  assert.deepEqual(parseEnvFile('A="x\nB="y\nz"'), [
    { name: 'A', value: 'x\nB="y\nz' },
  ]);
});

test('F25: an address with a password in it still counts as a secret', () => {
  assert.equal(looksRandom('postgres://me:s3cretPassw0rd@db.example.com/x'), true);
  assert.equal(looksRandom('https://opulent-moose-249.ap-southeast-2.convex.cloud'), false);
  assert.equal(looksRandom('https://a:@host.example.com/aaaaaaaaaaaaaaaa'), false, 'no password');
  assert.equal(looksRandom('https://:pw@host.example.com/aaaaaaaaaaaaaaaa1'), false, 'no user');
  const url = 'postgres://me:s3cretPassw0rd99@db.example.com/x';
  assert.deepEqual(valuesOfVariable('DATABASE_URL', url), [url]);
  assert.deepEqual(valuesOfVariable('SITE_URL', 'https://plain.example.com/path'), []);
  const site = 'https://admin:Zq8vN3xLp0Rt5Wm@site.example.com/x';
  assert.deepEqual(valuesOfVariable('SITE_URL', site), [site]);
});

test('F25: long runs in .env files parse in linear time', () => {
  for (const ws of [' ', '\t', IDEO_SPACE]) {
    assert.deepEqual(fast('comment', () => parseEnvFile(`FOO=a${ws.repeat(35_000)}b`)), [{ name: 'FOO', value: `a${ws.repeat(35_000)}b` }]);
    assert.deepEqual(fast('lone \\r', () => parseEnvFile(`FOO=${ws.repeat(35_000)}x\ry`)), []);
  }
  assert.equal(fast('colons', () => looksRandom(`a://${':'.repeat(35_000)}`)), false);
  assert.deepEqual(fast('colons', () => valuesOfVariable('X_URL', `a://${':'.repeat(35_000)}`)), []);
  // A value's later line with a quote mark per comment, each with a line
  // break at the end after it, so none of them closes it.
  const quotes = `A="x\n${'" #'.repeat(12_000)}\r`;
  assert.deepEqual(fast('quotes', () => parseEnvFile(quotes)), [{ name: 'A', value: 'x' }]);
  // A quote that never closes, on every line.
  assert.equal(fast('unclosed', () => parseEnvFile('A="x\n'.repeat(8000))).length, 8000);
});

test('F25: a folder with hundreds of .env files is read in full, as before', async (t) => {
  // No count limit: one that stopped at 500 let a repo's junk push your own
  // .env.qa.local out of the mask (Codex's review of this fix).
  const home = tmpDir();
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(repo, `.env.aaa${String(i).padStart(3, '0')}`), 'PLAIN=1\n');
  const own = `${crypto.randomBytes(24).toString('base64url')}7`;
  fs.writeFileSync(path.join(repo, '.env.qa.local'), `QA_PASSWORD=${own}\n`);
  // Check the file count independently of the scan's real-time deadline.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const known = new KnownValues({ env: {}, home });
  known.noteFolder(repo);
  assert.equal(await known.settled(), true);
  assert.equal(known.unread, 0);
  assert.ok(!known.mask(`it is ${own}`).includes(own));
});

test("F25: a repo's many .env files of long runs are read in linear time", async (t) => {
  // The scan's case: many .env.<x> files, each a line of a long run, in the
  // thread's folder and the ones inside it. CPU time rather than the clock,
  // so a busy machine doesn't count: each file took a second of it before.
  const home = tmpDir();
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
  for (const [i, dir] of [repo, path.join(repo, 'web')].entries()) {
    for (let j = 0; j < 5; j++) fs.writeFileSync(path.join(dir, `.env.x${i}${j}`), `FOO=a${' '.repeat(35_000)}b\nX_URL=a://${':'.repeat(35_000)}\n`);
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const known = new KnownValues({ env: {}, home });
  const cpu = process.cpuUsage();
  known.noteFolder(repo);
  await known.settled();
  const { user, system } = process.cpuUsage(cpu);
  assert.equal(known.unread, 0);
  assert.ok((user + system) / 1000 < 500, `reading them took ${Math.round((user + system) / 1000)} ms of CPU`);
});

// ----------------------------------------------------------------- F24

test('F24: a leaked tool call comes off a Codex answer as before', () => {
  const cases: [string, string][] = [
    ['Done.\nto=functions.exec code', 'Done.'],
    ['to=functions.exec at the start', ''],
    ['All done. analysis to=functions.end_turn {"x":1}', 'All done.'],
    // The word before the spaces goes too: here, "done.".
    ['All done.  to=multi_tool_use.parallel', 'All'],
    ['All done. 다음 to=tools.x', 'All done.'],
    // A \r is a space here, not a line's end: the word before it goes.
    ['Done.\r to=functions.x', ''],
    ['Done.\tglued\tto=functions.x', 'Done.'],
    ['It wrote `to=functions.exec` into the reply.', 'It wrote `to=functions.exec` into the reply.'],
    ['It wrote `x to=functions.exec` there.', 'It wrote `'],
    ['Set to=5 and rerun.', 'Set to=5 and rerun.'],
    ['a\nb to=functions.\n', 'a\nb to=functions.\n'],
    ['word to=functions.x to=functions.y', ''],
    ['one\ntwo three to=tools.a', 'one\ntwo'],
    ['x`y to=functions.a', 'x`'],
  ];
  for (const [text, want] of cases) assert.equal(stripLeakedToolCall(text), want, JSON.stringify(text));
});

test('F24: long runs of spaces or one long token in an answer are linear', () => {
  for (const ws of [' ', '\t', IDEO_SPACE]) {
    const text = `a${ws.repeat(1500)}b`;
    assert.equal(fast('spaces', () => stripLeakedToolCall(text)), text);
    assert.equal(fast('spaces then a call', () => stripLeakedToolCall(`${text}${ws.repeat(10_000)}to=functions.x`)), 'a', 'b is the word glued on');
  }
  const blob = 'x'.repeat(40_000);
  assert.equal(fast('token', () => stripLeakedToolCall(blob)), blob);
  const glued = 'xto=functions.a'.repeat(10_000);
  assert.equal(fast('tokens', () => stripLeakedToolCall(glued)), glued, 'never after a space or at a line start');
});

// ----------------------------------------------------------------- F27

test('F27: the shell wrapper comes off a Codex command as before', () => {
  const cases: [string, string][] = [
    ["/bin/zsh -lc 'echo hi'", 'echo hi'],
    ['/bin/zsh -lc ls', 'ls'],
    ["/bin/zsh -lc 'echo '\\''quoted'\\'''", "echo 'quoted'"],
    ['bash -c "echo \\"x\\""', 'echo "x"'],
    ['git status', 'git status'],
    ["/bin/zsh -lc 'a' 'b'", "/bin/zsh -lc 'a' 'b'"],
    ["  sh   -c   'ls -la'   ", 'ls -la'],
    ["/usr/local/bin/bash -lc 'x'", 'x'],
    ["fish -c 'x'", "fish -c 'x'"],
    ["/bin/zsh/x -c 'y'", "/bin/zsh/x -c 'y'"],
    ["zsh -lc 'a b'\n", 'a b'],
    ['zsh -c  ', 'zsh -c  '],
    ['zsh -c ', 'zsh -c '],
    ['zsh -cx', 'zsh -cx'],
    ['zsh -lc a b', 'zsh -lc a b'],
    ['zsh -lc "unclosed', '"unclosed'],
  ];
  for (const [command, want] of cases) assert.equal(innerCommand(command), want, JSON.stringify(command));
});

test('F27: a command with a long run of spaces is unwrapped in linear time', () => {
  const inner = `printf %s '${' '.repeat(35_000)}x'`;
  assert.equal(fast('innerCommand', () => innerCommand(`/bin/zsh -lc "${inner}"`)), inner);
  const spaces = `/bin/zsh -lc 'printf %s '${' '.repeat(35_000)}x'`;
  assert.equal(fast('innerCommand', () => innerCommand(spaces)), spaces);
  const lead = `${' '.repeat(35_000)}x`;
  assert.equal(fast('innerCommand', () => innerCommand(lead)), lead);
});

// ----------------------------------------------------------------- F26

test('F26: a reply section is read as before', () => {
  const bare = splitReplySection('Fixed it.\n\nWhat I need from you:\n1. Tell me whether to deploy.\n2. Check the logs.');
  assert.equal(bare.reply, 'Fixed it.');
  assert.equal(bare.needs?.needs, 'you');
  assert.equal(bare.needs?.asks?.length, 2);
  for (const heading of ['**What I need from you:**', '**What I need from you**:', '## What I need from you', '  What I need from you  :  ** : ', 'what i need from you']) {
    const s = splitReplySection(`Done.\n\n${heading}\n- Run it with your key.`);
    assert.equal(s.reply, 'Done.', heading);
    assert.equal(s.needs?.asks?.[0]?.action, 'Run it with your key.', heading);
  }
  assert.deepEqual(needsFromText('Done.\n\n**What I need from you:** nothing right now.'), { needs: 'nothing' });
  assert.equal(needsFromText('Done.\n\n**What I need from you** run `tb land`')?.asks?.[0]?.action, 'run `tb land`');
  assert.equal(needsFromText('Done.\nWhat I need from you: in a sentence'), undefined, 'neither bold nor a heading');
  assert.equal(needsFromText(`Done.\n**What I need from you:** a${LS}b`), undefined, 'a line separator left the line unread');
  assert.equal(needsFromText(`**What I need from you:**\n- a${LS}b\n- c`)?.asks?.map((a) => a.action).join('|'), 'c');
  assert.deepEqual(needsFromText('All set.\n\nNothing needed from you right now.'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('All set. **Nothing needed from you.**'), { needs: 'nothing' });
  assert.deepEqual(needsFromText('Tests pass and   ** nothing else needed from you.'), { needs: 'nothing' });
  assert.equal(needsFromText('The script says nothing needed from you is wrong'), undefined);
  assert.deepEqual(
    needsFromText('**What I need from you:**\n- Check [the PR](https://x.dev/pr/1) and **reply** "ok"')?.asks,
    [{ action: 'Check [the PR](https://x.dev/pr/1) and reply "ok"', reply: 'ok' }],
  );
  assert.deepEqual(needsFromText('Nothing needed from you right now.\n\n- [Check the logs](https://x.dev) tomorrow. It may be slow.'), { needs: 'nothing', next: ['Check the logs tomorrow'] });
});

test('F26: a reply line of "What I need from you" and a long run of spaces is linear', () => {
  for (const ws of [' ', '\t', IDEO_SPACE]) {
    const line = `What I need from you${ws.repeat(300)}.`;
    assert.deepEqual(fast('splitReplySection', () => splitReplySection(line)), { reply: line });
    fast('needsFromText', () => needsFromText(`What I need from you${ws.repeat(90)}x${LS}y`));
    fast('leading', () => needsFromText(`${ws.repeat(40_000)}x`));
    fast('nothing line', () => needsFromText(`.${ws.repeat(40_000)}x`));
    fast('nothing line', () => needsFromText(`and${ws.repeat(40_000)}x`));
    fast('item', () => needsFromText(`**What I need from you:**\n- ${ws.repeat(40_000)}x${LS}y`));
    fast('replyWithoutRepeat', () => replyWithoutRepeat(`Done.\n\nWhat I need from you${ws.repeat(300)}.`, { needs: 'you', asks: [{ action: 'x' }] }));
  }
  fast('links in a follow-up', () => needsFromText(`Nothing needed from you.\n\n- ${'['.repeat(30_000)}`));
});

// ----------------------------------------------------------------- F29

test('F29: a worktree resolves to its main checkout as before', () => {
  const root = tmpDir();
  const main = path.join(root, 'app');
  const wt = path.join(root, 'app-wt');
  fs.mkdirSync(path.join(main, '.git/worktrees/wt'), { recursive: true });
  fs.mkdirSync(wt);
  for (const line of [`gitdir: ${main}/.git/worktrees/wt\n`, `gitdir:${main}/.git/worktrees/wt  \r\n`, `gitdir: ../app/.git/worktrees/wt`]) {
    fs.writeFileSync(path.join(wt, '.git'), line);
    assert.equal(mainCheckout(wt), main, JSON.stringify(line));
  }
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere/else\n');
  assert.equal(mainCheckout(wt), wt, 'not a worktree of anything');
  assert.equal(mainCheckout(main), main, 'a .git folder');
  assert.equal(mainCheckout(path.join(root, 'none')), path.join(root, 'none'));
});

test('F29: a .git file of a long run of spaces is read in linear time', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: a${' '.repeat(20_000)}b`);
  assert.equal(fast('mainCheckout', () => mainCheckout(dir)), dir);
});

// ----------------------------------------------------------------- F30

test('F30: links in a reply are found as before', () => {
  assert.deepEqual(linkItem('https://x.dev/a).'), { id: 'link:https://x.dev/a', kind: 'link', title: 'x.dev/a', url: 'https://x.dev/a' });
  assert.equal(linkItem('**https://x.dev/**').url, '**https://x.dev/');
  assert.equal(linkItem('https://x.dev/a_b_').url, 'https://x.dev/a_b');
  assert.equal(linkItem('https://github.com/a/b/pull/12,').id, 'pr:https://github.com/a/b/pull/12');
  const found = linksIn('See [the docs](https://x.dev/docs), [`notes`](https://x.dev/n) and https://y.dev/z.\n[x\ny](https://no.dev) [](https://empty.dev) [a](https://sp ace.dev)', noFiles);
  assert.deepEqual(
    found.map((f) => [f.url, f.title]),
    [
      ['https://x.dev/docs', 'the docs'],
      ['https://x.dev/n', 'notes'],
      ['https://empty.dev', 'empty.dev'],
      ['https://y.dev/z', 'y.dev/z'],
      ['https://no.dev', 'no.dev'],
    ],
  );
  assert.deepEqual(pushedBranches(' * [new branch]      feature -> feature\n   a1b2c3d..e4f5a6b  main -> main\n+ 1234567...89abcde f -> f\n\n  *\n   [new branch] g -> g'), ['feature', 'main', 'f', 'g']);
});

test('F30: a link then a long run of punctuation is linear', () => {
  for (const mark of ['_', '.', ':', '*', '~']) {
    const item = fast('linkItem', () => linkItem(`https://a.co/${mark.repeat(40_000)}x`));
    assert.equal(item.url, `https://a.co/${mark.repeat(40_000)}x`);
  }
  assert.deepEqual(fast('linksIn', () => linksIn(`https://a.co/${'_'.repeat(12_000)}x`, noFiles)), [], `longer than ${MAX_URL} is no link`);
  fast('markdown links', () => linksIn('[]('.repeat(20_000), noFiles));
  fast('pushedBranches', () => pushedBranches('\n'.repeat(1000)));
  // `^` starts again after any line break, not only \n.
  for (const nl of ['\r', LS, String.fromCharCode(0x2029)]) fast('pushedBranches', () => pushedBranches(nl.repeat(50_000)));
});

// ------------------------------------------------ the same shapes elsewhere

test('markdown images in a shared thread are found as before', () => {
  const typeOf = (p: string) => (p.endsWith('.png') ? 'image/png' : undefined);
  const text = '![a](/x/a.png) ![b](<~/b c.png> "title") ![c]( /x/c.png  "t" ) ![d](/x/d.png "unclosed) ![e](/x/a.png) ![f](</x/f.png)';
  assert.deepEqual(markdownImages(text, '/Users/x', typeOf as never).map((i) => i.src), ['/x/a.png', '~/b c.png', '/x/c.png']);
});

test('markdown images in a long run of "![" are found in linear time', () => {
  fast('markdownImages', () => markdownImages('!['.repeat(30_000), '/Users/x', (() => undefined) as never));
  fast('markdownImages', () => markdownImages(`${'![](a'.repeat(3000)}${' '.repeat(3000)}x`, '/Users/x', (() => undefined) as never));
});

test('Notion and thread titles lose their wrappers as before', () => {
  assert.equal(notionTitle('<p> WIN TV Book in TVC </p>'), 'WIN TV Book in TVC');
  assert.equal(notionTitle('<P class="x">Hi</P>  '), 'Hi');
  assert.equal(notionTitle('<pre>x</p>'), '<pre>x</p>');
  assert.equal(notionTitle('About <div>s'), 'About <div>s');
  assert.equal(notionTitle('<p </p>'), '<p </p>');
  assert.equal(notionTitle('<p>a</p> b'), '<p>a</p> b');
  assert.equal(cleanTitle('**Fix the build**'), 'Fix the build');
});

test('Notion titles with long runs lose their wrappers in linear time', () => {
  assert.equal(fast('notion title', () => notionTitle(`<p>${' '.repeat(1600)}x`)), `<p>${' '.repeat(1600)}x`);
});

test('a pinned page counts as having scripts as before', () => {
  const dir = tmpDir();
  const page = (name: string, html: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, html);
    return file;
  };
  assert.equal(pageHasScripts(page('a.html', '<body onload="draw()">')), true);
  assert.equal(pageHasScripts(page('b.html', '<a\nONCLICK = "x">')), true);
  assert.equal(pageHasScripts(page('c.html', '<p>Say onclick= in a sentence</p>')), false);
  assert.equal(pageHasScripts(page('d.html', '<p> < onx=1')), true);
  assert.equal(pageHasScripts(page('e.html', '<a href="javascript:void(0)">')), true);
  assert.equal(pageHasScripts(page('f.html', '<SCRIPT src=x>')), true);
  assert.equal(pageHasScripts(page('g.html', '<p>plain</p>')), false);
});

test('a pinned page of a long run of "<" is checked in linear time', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'p.html');
  fs.writeFileSync(file, '<'.repeat(45_000));
  assert.equal(fast('pageHasScripts', () => pageHasScripts(file)), false);
  fs.writeFileSync(file, `${'<'.repeat(50_000)} onx=1`);
  assert.equal(fast('pageHasScripts', () => pageHasScripts(file)), true);
});

test('a Notion database reads as before', () => {
  const view = (id: string, json: string) => `<view url="{{view://${id}}}">${json}</view>`;
  assert.equal(pickView(view('a1', ' {"filter": {"x": 1}} ') + view('b2', '\n{"sorts": [], "q": "{{collection://c3}}"}\n')), 'view://b2');
  // Junk after a view's JSON runs it on to the next view's end, which
  // isn't JSON, and takes the next view with it.
  assert.equal(pickView(view('a1', '{"x": 1} junk') + view('b2', '{}')), undefined);
  assert.equal(pickView(view('a1', '{"x": 1} junk') + view('b2', '{}') + view('c3', '{}')), 'view://c3');
  assert.equal(pickView(`<view url="{{view://a1}}">{"x": </view>"}</view>`), undefined, 'the JSON runs to a "}" before </view>');
  assert.equal(pickView(view('a1', 'no json')), undefined);
  const schema = (text: string) => readSchema(JSON.stringify({ text }));
  assert.equal(schema('<data-source-state> {"schema": {"Name": {"name": "Name", "type": "title"}}} </data-source-state>').title, 'Name');
  assert.throws(() => schema('<data-source-state>   </data-source-state>'), /columns/);
});

const notionPage = (text: string) => async (_tool: string, args: Record<string, unknown>) =>
  JSON.stringify(String(args.id).startsWith('page') ? { text, metadata: { type: 'page' } } : { text: '', url: String(args.id) });

test('a Notion page names its task database as before', async () => {
  const db = (url: string, title: string) => `<database url="${url}" data-source-url="collection://ab-12" x="1">  ${title}\n</database>`;
  const source = await findSource(notionPage(`intro ${db('https://n.so/1', 'Notes')} ${db('https://n.so/2', ' Tasks ')}`) as never, 'page-1');
  assert.equal(source.databaseUrl, 'https://n.so/2');
  assert.equal(source.dataSource, 'collection://ab-12');
  await assert.rejects(findSource(notionPage('<database url="x" data-source-url="collection://a">t</database x>') as never, 'page-1'), /No database/);
});

test('a Notion page of unclosed database tags is read in linear time', async () => {
  const text = '<database url="x" data-source-url="collection://a"'.repeat(6000);
  let best = Infinity;
  for (let i = 0; i < 5 && best >= 100; i++) {
    const t0 = performance.now();
    await assert.rejects(findSource(notionPage(text) as never, 'page-1'), /No database/);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 100, `findSource took ${Math.round(best)} ms`);
});

test('a Notion database with long runs reads in linear time', () => {
  const open = '<view url="{{view://a1}}">{';
  assert.equal(fast('pickView', () => pickView(open.repeat(17_000))), undefined);
  assert.equal(fast('pickView', () => pickView(`<view url="{{view://a1}}">{"a": "${'{{x://'.repeat(18_000)}"}</view>`)), 'view://a1');
  assert.throws(() => fast('readSchema', () => readSchema(JSON.stringify({ text: `<data-source-state>${' '.repeat(2000)}x` }))), /columns/);
});

// The helpers against the regexes they stand for, on short random text made
// of the characters that matter to each.
test('linear-text helpers give what the regexes they replaced gave', async () => {
  const L = await import('../../src/linear-text.ts');
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const text = (pieces: string[]) => Array.from({ length: rnd(24) }, () => pieces[rnd(pieces.length)]).join('');
  const WS = [' ', '\t', '\r', '\n', LS, IDEO_SPACE];
  const same = (name: string, pieces: string[], regex: (s: string) => unknown, helper: (s: string) => unknown) => {
    for (let i = 0; i < 3000; i++) {
      const s = text(pieces);
      assert.deepEqual(helper(s), regex(s), `${name} on ${JSON.stringify(s)}`);
    }
  };
  same('stripEnvComment', [...WS, '#', 'x'], (s) => s.replace(/\s+#.*$/, ''), L.stripEnvComment);
  same('hasUrlCredentials', ['://', ':', '@', '/', 'a', ' ', '\n'], (s) => /:\/\/[^/@\s]+:[^/@\s]+@/.test(s), L.hasUrlCredentials);
  same('cutQueryAndHash', ['?', '#', 'a', '\n', '\r', LS], (s) => s.replace(/[?#].*$/, ''), L.cutQueryAndHash);
  same('outermostBraces', ['{', '}', 'a', '\n'], (s) => /\{[\s\S]*\}/.exec(s)?.[0], L.outermostBraces);
  same('trimEndOf', ['/', 'a'], (s) => s.replace(/\/+$/, ''), (s) => L.trimEndOf(s, '/'));
  same('trimEndOfOrSpace', ['.', 'a', ...WS], (s) => s.replace(/[.\s]+$/, ''), (s) => L.trimEndOfOrSpace(s, '.'));
  same('trimStartOf', ['*', 'a'], (s) => s.replace(/^\*+/, ''), (s) => L.trimStartOf(s, '*'));
  const LINK = ['[', ']', '(', ')', '](', 'a', ' ', '\n'];
  same('replaceLinks', LINK, (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '<$1>'), (s) => L.replaceLinks(s, { titleStopsAtNewline: false, titleMin: 1, titleMax: Infinity, targetStopsAtSpace: false, targetMin: 0 }, (t) => `<${t}>`));
  same('replaceLinks', LINK, (s) => s.replace(/\[([^\]\n]{0,3})\]\(([^)\s]+)\)/g, '<$1|$2>'), (s) => L.replaceLinks(s, { titleStopsAtNewline: true, titleMin: 0, titleMax: 3, targetStopsAtSpace: true, targetMin: 1 }, (t, u) => `<${t}|${u}>`));
});
