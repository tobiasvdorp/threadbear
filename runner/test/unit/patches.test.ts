import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { checkPanel } from '../helpers/protocol-check.ts';
import { CONVEX_DASHBOARD, CONVEX_LOCAL_DASHBOARD, convexDashboardUrl, parseEnvValue, projectPanels, renderPanel } from '../../src/patches.ts';

function project(home: string, rel: string, files: Record<string, string | null> = {}): string {
  const dir = path.join(home, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (text === null) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, text);
  }
  return dir;
}

test('a folder with convex/ gets the dashboard panel for its deployment', () => {
  const home = tmpDir();
  const dir = project(home, 'dev/app', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:happy-otter-123 # team: mike\nCONVEX_URL=https://happy-otter-123.convex.cloud\n' });
  const panels = projectPanels(dir, home);
  assert.equal(panels.length, 1);
  assert.deepEqual(checkPanel(panels[0] as never), []);
  assert.deepEqual(panels[0], {
    id: 'convex.dashboard', title: 'Convex', kind: 'url', icon: 'cylinder.split.1x2', patch: 'convex',
    url: 'https://dashboard.convex.dev/d/happy-otter-123', note: 'happy-otter-123 (dev)',
    convex: { deployment: 'happy-otter-123', deploymentUrl: 'https://happy-otter-123.convex.cloud' },
  });
});

test('the Convex panel names the project convex dev noted after the deployment', () => {
  const home = tmpDir();
  const dir = project(home, 'dev/walkies', { convex: null, 'package.json': '{}', '.env.local': '# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=dev:happy-otter-123 # team: mike, project: walkies\nCONVEX_URL=https://happy-otter-123.convex.cloud\n' });
  assert.deepEqual(projectPanels(dir, home)[0].convex, {
    deployment: 'happy-otter-123', deploymentUrl: 'https://happy-otter-123.convex.cloud', team: 'mike', project: 'walkies',
  });
});

test('the Convex panel offers the embedded dashboard only for a cloud deployment with its URL', () => {
  const home = tmpDir();
  const vite = project(home, 'dev/vite', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:calm-cat-1\nVITE_CONVEX_URL=https://calm-cat-1.eu-west-1.convex.cloud\nCONVEX_SITE_URL=https://calm-cat-1.convex.site\n' });
  assert.deepEqual(projectPanels(vite, home)[0].convex, { deployment: 'calm-cat-1', deploymentUrl: 'https://calm-cat-1.eu-west-1.convex.cloud' });
  const noUrl = project(home, 'dev/nourl', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:calm-cat-2\n' });
  assert.equal(projectPanels(noUrl, home)[0].convex, undefined);
  const local = project(home, 'dev/local', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=local:my-local-1\nCONVEX_URL=http://127.0.0.1:3210\n' });
  assert.equal(projectPanels(local, home)[0].convex, undefined);
  const anon = project(home, 'dev/anon', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=anonymous:anonymous-app\nCONVEX_URL=https://x.convex.cloud\n' });
  assert.equal(projectPanels(anon, home)[0].convex, undefined);
  // The name goes on a command line, so anything odd isn't offered.
  const odd = project(home, 'dev/odd', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:x;rm -rf ~\nCONVEX_URL=https://x.convex.cloud\n' });
  assert.equal(projectPanels(odd, home)[0].convex, undefined);
  // The URL is handed a deploy key, and a cloned repo writes the env file:
  // only the deployment's own convex.cloud address gets the dashboard.
  const evil = ['https://evil.example', 'https://calm-cat-3.convex.cloud.evil.example', 'https://other-dog-4.convex.cloud',
    'https://calm-cat-3.convex.cloud:8443', 'https://u:p@calm-cat-3.convex.cloud', 'https://xcalm-cat-3.convex.cloud']
    .map((url, i) => project(home, `dev/evil${i}`, { convex: null, 'package.json': '{}', '.env.local': `CONVEX_DEPLOYMENT=dev:calm-cat-3\nCONVEX_URL=${url}\n` }));
  for (const p of evil) assert.equal(projectPanels(p, home)[0].convex, undefined, fs.readFileSync(path.join(p, '.env.local'), 'utf8'));
  for (const p of [vite, noUrl, local, anon, odd, ...evil]) assert.deepEqual(checkPanel(projectPanels(p, home)[0] as never), []);
});

test('a thread in a package of the project still gets the project panels; nothing above home', () => {
  const home = tmpDir();
  project(home, 'dev/app', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=prod:big-cat-9\n' });
  const sub = project(home, 'dev/app/packages/web');
  assert.equal(projectPanels(sub, home)[0]?.url, 'https://dashboard.convex.dev/d/big-cat-9');
  // A convex/ folder in the fake home's parent isn't found from inside home.
  fs.mkdirSync(path.join(path.dirname(home), 'convex'), { recursive: true });
  try {
    assert.deepEqual(projectPanels(project(home, 'dev/plain'), home), []);
  } finally {
    fs.rmSync(path.join(path.dirname(home), 'convex'), { recursive: true, force: true });
  }
});

test('dashboard URLs: no deployment, anonymous local, quoted .env values, .env.local first', () => {
  assert.deepEqual(convexDashboardUrl(undefined), { url: CONVEX_DASHBOARD, note: 'No deployment in .env.local yet' });
  assert.deepEqual(convexDashboardUrl('anonymous:anonymous-app'), { url: CONVEX_LOCAL_DASHBOARD, note: 'anonymous-app, local; the dashboard is up while convex dev runs' });
  assert.equal(convexDashboardUrl('local:my-local-1').url, 'https://dashboard.convex.dev/d/my-local-1');
  assert.equal(convexDashboardUrl('odd name').url, 'https://dashboard.convex.dev/d/odd%20name');
  assert.equal(parseEnvValue('export CONVEX_DEPLOYMENT="dev:quoted-1"\n', 'CONVEX_DEPLOYMENT'), 'dev:quoted-1');
  assert.equal(parseEnvValue("CONVEX_DEPLOYMENT='dev:single-1'", 'CONVEX_DEPLOYMENT'), 'dev:single-1');
  assert.equal(parseEnvValue('# CONVEX_DEPLOYMENT=dev:commented\nOTHER=1\n', 'CONVEX_DEPLOYMENT'), undefined);
  const home = tmpDir();
  const dir = project(home, 'p', { convex: null, 'package.json': '{}', '.env': 'CONVEX_DEPLOYMENT=prod:from-env\n', '.env.local': 'CONVEX_DEPLOYMENT=dev:from-local\n' });
  assert.equal(projectPanels(dir, home)[0]?.note, 'from-local (dev)');
});

test('an Xcode project gets the Simulator panel; both patches can apply', () => {
  const home = tmpDir();
  const ios = project(home, 'dev/Walkies', { 'Walkies.xcodeproj': null });
  const panels = projectPanels(ios, home);
  assert.deepEqual(panels, [{ id: 'xcode.simulator', title: 'Simulator', kind: 'image', icon: 'iphone', patch: 'xcode', note: 'Walkies' }]);
  assert.deepEqual(checkPanel(panels[0] as never), []);
  const both = project(home, 'dev/Both', { 'App.xcworkspace': null, convex: null, 'package.json': '{}' });
  assert.deepEqual(projectPanels(both, home).map((p) => p.id), ['convex.dashboard', 'xcode.simulator']);
  assert.deepEqual(projectPanels(project(home, 'dev/nothing'), home), []);
});

test('rendering the Simulator panel: a screenshot becomes an image ref, no device a note', async () => {
  const dir = path.join(tmpDir(), 'panels');
  const panel = { id: 'xcode.simulator', title: 'Simulator', kind: 'image' as const, patch: 'xcode' };
  const ok = await renderPanel(panel, dir, async (file) => fs.writeFileSync(file, makePng(40, 30)));
  assert.equal(ok.note, undefined);
  assert.equal(ok.image?.path, path.join(dir, 'xcode.simulator.png'));
  assert.equal(ok.image?.mediaType, 'image/png');
  assert.equal(ok.image?.width, 40);
  assert.equal(ok.image?.height, 30);
  // Rendered again: the same file, overwritten, no leftovers.
  await renderPanel(panel, dir, async (file) => fs.writeFileSync(file, makePng(10, 10)));
  assert.deepEqual(fs.readdirSync(dir), ['xcode.simulator.png']);
  const none = await renderPanel(panel, dir, async () => { throw new Error('No devices are booted.'); });
  assert.equal(none.image, undefined);
  assert.equal(none.note, 'No simulator is booted. Build and run, or open Simulator.');
  const other = await renderPanel(panel, dir, async () => { throw new Error('xcrun: error: unable to find utility "simctl"\nmore'); });
  assert.equal(other.note, 'Couldn\'t take a screenshot: xcrun: error: unable to find utility "simctl"');
  const url = await renderPanel({ id: 'convex.dashboard', title: 'Convex', kind: 'url', url: 'https://x', patch: 'convex' }, dir);
  assert.equal(url.note, 'This panel has nothing to render.');
});

import { loadPatchSet, readPatchModule, runCommand, slug, webPage } from '../../src/patches.ts';
import { checkAction } from '../helpers/protocol-check.ts';
import { tick } from '../helpers/fakes.ts';

function writePatch(dir: string, name: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('patch files in the project and in home give actions and panels, with ids from the title', async () => {
  const home = tmpDir();
  const app = project(home, 'dev/app', { convex: null, 'package.json': '{}' });
  const file = writePatch(path.join(app, '.threadbear/patches'), 'reseed.ts', `
    export default {
      actions: [
        { title: "Reseed dev DB", run: "npx convex run seed:reset", note: "Dev only" },
        { title: "Explain the schema", prompt: "Read convex/schema.ts and explain it." },
      ],
      panels: [{ title: "Storybook", url: "http://localhost:6006" }],
    } satisfies Record<string, unknown>;
  `);
  const homeFile = writePatch(path.join(home, '.threadbear/patches'), 'everywhere.mjs', `export default { actions: [{ title: "Disk space", run: "df -h ." }] };`);
  const set = await loadPatchSet(path.join(app, 'packages/web'), home);
  fs.mkdirSync(path.join(app, 'packages/web'), { recursive: true });
  assert.deepEqual(set.patches, [
    { id: 'convex', source: 'builtin' },
    { id: 'everywhere', source: 'home', file: homeFile },
    { id: 'reseed', source: 'project', file },
  ]);
  assert.deepEqual(set.actions.map((a) => a.id), ['everywhere.disk-space', 'reseed.reseed-dev-db', 'reseed.explain-the-schema']);
  for (const a of set.actions) assert.deepEqual(checkAction(a as never), [], a.id);
  assert.deepEqual(set.actions[1], { id: 'reseed.reseed-dev-db', title: 'Reseed dev DB', kind: 'command', command: 'npx convex run seed:reset', patch: 'reseed', note: 'Dev only' });
  assert.deepEqual(set.actions[2], { id: 'reseed.explain-the-schema', title: 'Explain the schema', kind: 'prompt', prompt: 'Read convex/schema.ts and explain it.', patch: 'reseed' });
  assert.deepEqual(set.panels.map((p) => p.id), ['convex.dashboard', 'reseed.storybook']);
  assert.deepEqual(checkPanel(set.panels[1] as never), []);
});

test('a patch file that breaks is listed with its error and gives nothing; an edit reloads it', async () => {
  const home = tmpDir();
  const app = project(home, 'p');
  const dir = path.join(app, '.threadbear/patches');
  const file = writePatch(dir, 'broken.ts', 'export default { actions: [{ title: "No command" }] };');
  writePatch(dir, 'syntax.ts', 'export default {');
  writePatch(dir, 'types.d.ts', 'export {};');
  writePatch(dir, '.hidden.ts', 'export default { actions: [{ title: "Hidden", run: "true" }] };');
  const cache = new Map();
  let set = await loadPatchSet(app, home, cache);
  assert.deepEqual(set.actions, []);
  assert.equal(set.patches.length, 2);
  assert.equal(set.patches[0].id, 'broken');
  assert.equal(set.patches[0].error, 'actions[0] ("No command") needs run (a command), prompt (a message) or url (a page to open).');
  assert.equal(set.patches[1].id, 'syntax');
  assert.match(set.patches[1].error ?? '', /./);
  // Fixed: the file's mtime moves on, so it's read again.
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, 'export default { actions: [{ title: "Now fine", run: "true" }] };');
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(file, later, later);
  set = await loadPatchSet(app, home, cache);
  assert.deepEqual(set.actions.map((a) => a.id), ['broken.now-fine']);
  assert.equal(set.patches[0].error, undefined);
});

test('readPatchModule: a url action is a page to open, kept as given', () => {
  const loaded = readPatchModule('links', 'project', '/p/links.ts', {
    icon: 'link',
    actions: [
      { title: 'App Store Connect', url: 'https://appstoreconnect.apple.com/apps', note: 'The app', badge: () => 2 },
      { title: 'Local', url: " http://localhost:3000/a b?q='x'" },
    ],
  });
  assert.equal(loaded.info.error, undefined);
  assert.deepEqual(loaded.actions[0], { id: 'links.app-store-connect', title: 'App Store Connect', kind: 'url', url: 'https://appstoreconnect.apple.com/apps', patch: 'links', note: 'The app', icon: 'link' });
  // Normalised, so what the app opens is exactly what the runner checked.
  assert.equal(loaded.actions[1].url, 'http://localhost:3000/a%20b?q=%27x%27');
  assert.equal(webPage('HTTPS://Example.com'), 'https://example.com/');
  assert.equal(webPage('https://'), null);
});

test('readPatchModule: the shapes it refuses', () => {
  const read = (v: unknown) => readPatchModule('x', 'project', '/p/x.ts', v).info.error;
  assert.equal(read(undefined), 'The default export should be an object with actions and/or panels.');
  assert.equal(read([]), 'The default export should be an object with actions and/or panels.');
  assert.equal(read({ actions: {} }), 'actions should be an array.');
  assert.equal(read({ actions: [{ run: 'x' }] }), 'actions[0] needs a title.');
  assert.equal(read({ actions: [{ title: 'Both', run: 'x', prompt: 'y' }] }), 'actions[0] ("Both") should have one of run, prompt or url, not more.');
  assert.equal(read({ actions: [{ title: 'Both', run: 'x', url: 'https://a.dev' }] }), 'actions[0] ("Both") should have one of run, prompt or url, not more.');
  // Only web pages: a url chip must never be a way to run something.
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'x-apple.systempreferences:', 'localhost:3000', 'not a url', '', 42]) {
    assert.equal(read({ actions: [{ title: 'Bad', url }] }), 'actions[0] ("Bad") has a url that isn\'t an http or https page.', String(url));
  }
  assert.equal(read({ panels: [{ title: 'No url' }] }), 'panels[0] ("No url") needs a url, or an items function.');
  assert.equal(read({ panels: [{ title: 'Bad', url: 'localhost:3000' }] }), 'panels[0] ("Bad") needs a url, or an items function.');
  assert.equal(read({ actions: [{ title: 'Same!', run: 'a' }, { title: 'same', run: 'b' }] }), 'Two entries would both be called x.same; give them different titles.');
  assert.equal(read({}), undefined);
  assert.equal(slug('Reseed dev DB'), 'reseed-dev-db');
  assert.equal(slug('  ⌘  '), 'untitled');
});

test('runCommand: output, exit codes, the time limit and the size cap', async () => {
  const cwd = tmpDir();
  const sh = ['/bin/sh', '-c'];
  const env = { PATH: '/usr/bin:/bin', TB_TEST: 'yes' };
  const ok = await runCommand('echo "in $PWD $TB_TEST"; echo err >&2', { cwd, env, shell: sh });
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.truncated, false);
  assert.match(ok.text, new RegExp(`in ${fs.realpathSync(cwd)} yes`));
  assert.match(ok.text, /err/);
  const failed = await runCommand('echo nope; exit 3', { cwd, env, shell: sh });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.text.trim(), 'nope');
  // The deadline includes shell startup, so nothing is guaranteed to print
  // before it on a busy Mac. Output capture is checked above.
  const slow = await runCommand('sleep 60; echo never', { cwd, env, shell: sh, timeoutMs: 300 });
  assert.equal(slow.ok, false);
  assert.equal(slow.text, 'Stopped after 0.3 s.');
  const big = await runCommand('yes abcdefghij | head -c 200000', { cwd, env, shell: sh });
  assert.equal(big.ok, true);
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 64 * 1024);
  const missing = await runCommand('true', { cwd, env, shell: ['/no/such/shell', '-c'] });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /ENOENT/);
});

import { hookApplies } from '../../src/patches.ts';

test('hooks in a patch file: shape, defaults and the edited glob', () => {
  const read = (v: unknown) => readPatchModule('x', 'project', '/p/x.ts', v);
  const ok = read({ hooks: [
    { title: 'Typecheck', on: 'turn.end', run: 'npx tsc --noEmit', edited: '**/*.{ts,tsx}' },
    { title: 'Always say', on: 'turn.end', run: 'echo hi', tell: 'always', note: 'noisy' },
  ] });
  assert.equal(ok.info.error, undefined);
  assert.deepEqual(ok.hooks, [
    { id: 'x.typecheck', title: 'Typecheck', on: 'turn.end', command: 'npx tsc --noEmit', tell: 'failures', patch: 'x', edited: '**/*.{ts,tsx}' },
    { id: 'x.always-say', title: 'Always say', on: 'turn.end', command: 'echo hi', tell: 'always', patch: 'x', note: 'noisy' },
  ]);
  assert.equal(read({ hooks: [{ title: 'No trigger', run: 'x' }] }).info.error, 'hooks[0] ("No trigger") needs on: "turn.end" (the one trigger so far).');
  assert.equal(read({ hooks: [{ title: 'Bad tell', on: 'turn.end', run: 'x', tell: 'sometimes' }] }).info.error, 'hooks[0] ("Bad tell") has tell "sometimes"; it\'s "failures" (the default), "always" or "never".');
  assert.equal(read({ actions: [{ title: 'Same', run: 'a' }], hooks: [{ title: 'Same', on: 'turn.end', run: 'b' }] }).info.error, 'Two entries would both be called x.same; give them different titles.');
  const hook = ok.hooks[0];
  assert.equal(hookApplies(hook, ['/p/src/a.ts'], '/p'), true);
  assert.equal(hookApplies(hook, ['src/b.tsx'], '/p'), true);
  assert.equal(hookApplies(hook, ['/p/README.md', '/elsewhere/c.ts'], '/p'), false);
  assert.equal(hookApplies(hook, [], '/p'), false);
  assert.equal(hookApplies(ok.hooks[1], [], '/p'), true, 'no filter: every turn');
});

test('a folder that is only called convex is not a Convex project', async () => {
  const home = tmpDir();
  // Like ~/dev/convex: a folder of repos, no package.json beside it.
  project(home, 'dev/convex/some-repo');
  const thread = project(home, 'dev/me/misc');
  assert.deepEqual(projectPanels(thread, home), []);
  assert.deepEqual((await loadPatchSet(thread, home)).patches, []);
  // convex.json alone is enough.
  const cfg = project(home, 'dev/me/app', { convex: null, 'convex.json': '{}' });
  assert.equal(projectPanels(cfg, home)[0]?.id, 'convex.dashboard');
});

test("a project's folders add their patches: tagged with the project, run in their folder, clashes renamed", async () => {
  const home = tmpDir();
  // The thread runs in misc; its project spans two repos.
  const misc = project(home, 'dev/misc');
  const app = project(home, 'dev/app', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:app-1\n' });
  const web = project(home, 'dev/web', { convex: null, 'package.json': '{}', '.env.local': 'CONVEX_DEPLOYMENT=dev:web-2\n' });
  const ownFile = writePatch(path.join(misc, '.threadbear/patches'), 'checks.ts', `export default { actions: [{ title: "Lint", run: "echo misc" }] };`);
  const appFile = writePatch(path.join(app, '.threadbear/patches'), 'checks.ts', `export default {
    actions: [{ title: "Lint", run: "echo app" }],
    hooks: [{ title: "Typecheck", on: "turn.end", run: "tsc", edited: "**/*.ts" }, { title: "Any edit", on: "turn.end", run: "true" }],
  };`);
  // A patch dir above both is loaded once, as the thread's own.
  const shared = writePatch(path.join(home, 'dev/.threadbear/patches'), 'shared.ts', `export default { actions: [{ title: "Shared", run: "true" }] };`);
  const set = await loadPatchSet(misc, home, new Map(), [
    { folder: app, projectId: 'p_1' },
    { folder: web, projectId: 'p_1' },
    { folder: misc, projectId: 'p_2' }, // the thread's own folder: already loaded as its own
  ]);
  assert.deepEqual(set.patches, [
    { id: 'convex', source: 'builtin', folder: app, projectId: 'p_1' },
    { id: 'web:convex', source: 'builtin', folder: web, projectId: 'p_1' },
    { id: 'shared', source: 'project', file: shared },
    { id: 'checks', source: 'project', file: ownFile },
    { id: 'app:checks', source: 'project', file: appFile, folder: app, projectId: 'p_1' },
  ]);
  // Same title, so each says its folder.
  assert.deepEqual(set.panels.map((p) => [p.id, p.title, p.url, p.projectId]), [
    ['convex.dashboard', 'Convex · app', 'https://dashboard.convex.dev/d/app-1', 'p_1'],
    ['web:convex.dashboard', 'Convex · web', 'https://dashboard.convex.dev/d/web-2', 'p_1'],
  ]);
  assert.deepEqual(set.actions.map((a) => [a.id, a.patch, a.folder, a.projectId]), [
    ['shared.shared', 'shared', undefined, undefined],
    ['checks.lint', 'checks', undefined, undefined],
    ['app:checks.lint', 'app:checks', app, 'p_1'],
  ]);
  for (const a of set.actions) assert.deepEqual(checkAction(a as never), [], a.id);
  for (const p of set.panels) assert.deepEqual(checkPanel(p as never), [], p.id);
  const [typecheck, anyEdit] = set.hooks;
  assert.equal(typecheck.folder, app);
  // Only edits inside the hook's own folder count, matched relative to it.
  assert.equal(hookApplies(typecheck, [path.join(misc, 'x.ts')], misc), false);
  assert.equal(hookApplies(typecheck, [path.join(app, 'src/x.ts')], misc), true);
  assert.equal(hookApplies(anyEdit, [], misc), false, 'a project hook needs an edit in its folder');
  assert.equal(hookApplies(anyEdit, [path.join(misc, 'notes.md')], misc), false);
  assert.equal(hookApplies(anyEdit, [path.join(app, 'README.md')], misc), true);
  // The quick built-in set agrees on the panels.
  assert.deepEqual(projectPanels(misc, home, [{ folder: app, projectId: 'p_1' }, { folder: web, projectId: 'p_1' }]).map((p) => [p.id, p.title]), [
    ['convex.dashboard', 'Convex · app'],
    ['web:convex.dashboard', 'Convex · web'],
  ]);
});

test('panels that share a title name their folders, the thread\'s own included, and leave the cached patch alone', async () => {
  const home = tmpDir();
  const own = project(home, 'dev/own', { convex: null, 'package.json': '{}' });
  const other = project(home, 'dev/other', { convex: null, 'package.json': '{}' });
  // Two folders called site: the parent's name tells them apart.
  const siteA = project(home, 'dev/a/site');
  const siteB = project(home, 'dev/b/site');
  const panelPatch = `export default { panels: [{ title: "Preview", url: "http://localhost:3000" }, { title: "Docs", url: "http://localhost:4000" }] };`;
  writePatch(path.join(siteA, '.threadbear/patches'), 'preview.ts', panelPatch);
  writePatch(path.join(siteB, '.threadbear/patches'), 'preview.ts', panelPatch.replace(', { title: "Docs", url: "http://localhost:4000" }', ''));
  const cache = new Map();
  const folders = [other, siteA, siteB].map((folder) => ({ folder, projectId: 'p_1' }));
  const set = await loadPatchSet(own, home, cache, folders);
  assert.deepEqual(set.panels.map((p) => p.title), ['Convex · own', 'Convex · other', 'Preview · a/site', 'Docs', 'Preview · b/site']);
  // Read again with the same cache: titles don't pile up.
  const again = await loadPatchSet(own, home, cache, folders);
  assert.deepEqual(again.panels.map((p) => p.title), set.panels.map((p) => p.title));
  // On its own a panel keeps its plain title.
  assert.deepEqual((await loadPatchSet(own, home)).panels.map((p) => p.title), ['Convex']);
});

test("a thread inside a project's folder keeps its own patches as they were", async () => {
  const home = tmpDir();
  const app = project(home, 'dev/app', { convex: null, 'package.json': '{}' });
  const sub = project(home, 'dev/app/packages/web');
  const plain = await loadPatchSet(sub, home);
  const withProject = await loadPatchSet(sub, home, new Map(), [{ folder: app, projectId: 'p_1' }]);
  assert.deepEqual(withProject, plain);
});

test('a panel with an items function is a list panel, filled by renderListPanel in its folder', async () => {
  const { renderListPanel } = await import('../../src/patches.ts');
  const home = tmpDir();
  const app = project(home, 'dev/app', { 'package.json': '{}' });
  writePatch(path.join(app, '.threadbear/patches'), 'work.ts', `
    export default {
      panels: [
        { title: "Worktrees", icon: "arrow.triangle.branch", items: async ({ cwd, sh }) => [
          { title: "main", detail: cwd, tone: "done" },
          (await sh("echo from-sh")).trim(),
          { title: "", detail: "dropped: no title" },
          { title: "odd", tone: "loud", extra: 1 },
          { title: "grouped", section: " Shipped · 2 ", trailing: "5d" },
          { title: "long", section: "x".repeat(200), trailing: "y".repeat(50) },
          { title: "blank", section: "  ", trailing: 3 },
        ] },
        { title: "Broken", items: () => { throw new Error("no git here") } },
        { title: "Slow", items: () => new Promise(() => {}) },
        { title: "Not a list", items: () => 42 },
      ],
    };
  `);
  const set = await loadPatchSet(app, home);
  const [list, broken, slow, notList] = set.panels;
  assert.deepEqual(list, { id: 'work.worktrees', title: 'Worktrees', kind: 'list', icon: 'arrow.triangle.branch', patch: 'work' });
  assert.deepEqual(checkPanel(list as never), []);
  const commands: { command: string; cwd: string }[] = [];
  const ctx = {
    cwd: app,
    threadId: 't1',
    timeoutMs: 10_000,
    run: async (command: string, cwd: string) => {
      commands.push({ command, cwd });
      return runCommand(command, { cwd, env: process.env });
    },
  };
  assert.deepEqual(await renderListPanel(list!, set, ctx), {
    items: [
      { title: 'main', detail: app, tone: 'done' },
      { title: 'from-sh' },
      { title: 'odd' },
      { title: 'grouped', section: 'Shipped · 2', trailing: '5d' },
      { title: 'long', section: 'x'.repeat(80), trailing: 'y'.repeat(24) },
      { title: 'blank' },
    ],
  });
  assert.deepEqual(commands, [{ command: 'echo from-sh', cwd: app }]);
  assert.deepEqual(await renderListPanel(broken!, set, ctx), { note: "Couldn't fill this panel: no git here" });
  assert.match((await renderListPanel(slow!, set, { ...ctx, timeoutMs: 50 })).note ?? '', /took over/);
  assert.deepEqual(await renderListPanel(notList!, set, ctx), { note: "The panel's items function didn't return a list." });
  assert.equal(readPatchModule('x', 'project', '/x.ts', { panels: [{ title: 'Both', url: 'https://a.dev', items: () => [] }] }).info.error, 'panels[0] ("Both") should have url or items, not both.');
});

test('a tool patch (appliesTo) applies only where its name is found, from any project folder, and runs there', async () => {
  const home = tmpDir();
  const tool = project(home, 'dev/tandem', { 'package.json': '{}' });
  const file = writePatch(path.join(tool, '.threadbear/patches'), 'tandem.ts', `
    export default {
      appliesTo: "*.tandem",
      actions: [{ title: "Open in Tandem", run: "open *.tandem" }],
    };
  `);
  // Another project's patch with no appliesTo stays with that project.
  writePatch(path.join(tool, '.threadbear/patches'), 'build.ts', `export default { actions: [{ title: "Build", run: "swift build" }] };`);
  const video = project(home, 'videos/batching', { 'Batching.tandem': 'x', 'Short.tandem': null });
  const sub = project(home, 'videos/batching/broll');
  const plain = project(home, 'videos/other');

  const set = await loadPatchSet(sub, home, new Map(), [], [tool]);
  assert.deepEqual(set.patches, [{ id: 'tandem', source: 'project', file, folder: video, matched: [path.join(video, 'Batching.tandem'), path.join(video, 'Short.tandem')] }]);
  assert.deepEqual(set.actions, [{ id: 'tandem.open-in-tandem', title: 'Open in Tandem', kind: 'command', command: 'open *.tandem', patch: 'tandem', folder: video }]);
  for (const a of set.actions) assert.deepEqual(checkAction(a as never), []);
  assert.deepEqual((await loadPatchSet(plain, home, new Map(), [], [tool])).patches, []);
  // In the tool's own repo, with no .tandem file, only its own patch applies.
  assert.deepEqual((await loadPatchSet(tool, home, new Map(), [], [tool])).patches.map((p) => p.id), ['build']);
  // Found through one of the thread's projects' folders too, tagged with it.
  const misc = project(home, 'dev/misc');
  const viaProject = await loadPatchSet(misc, home, new Map(), [{ folder: video, projectId: 'p_v' }], [tool]);
  assert.equal(viaProject.patches[0]?.folder, video);
  assert.equal(viaProject.actions[0]?.projectId, 'p_v');
  assert.equal(readPatchModule('x', 'project', '/x.ts', { appliesTo: 'a/*.tandem' }).info.error, 'appliesTo should be a name glob like "*.tandem", or a list of them (names in a folder, no slashes).');
});

test('live state: when hides, badge counts, label retitles, a shared command runs once, a failure is liveError', async () => {
  const { applyLive, hasLive } = await import('../../src/patches.ts');
  const home = tmpDir();
  const app = project(home, 'dev/app', { 'package.json': '{}' });
  writePatch(path.join(app, '.threadbear/patches'), 'review.ts', `
    const count = async ({ sh }) => JSON.parse(await sh("echo '{\\"n\\":3}'")).n;
    export default {
      actions: [
        { title: "Your turn", prompt: "Do my comments.", when: async (ctx) => (await count(ctx)) > 0, badge: count },
        { title: "Hidden", run: "true", when: () => false },
        { title: "Plain", run: "true" },
        { title: "Zero", run: "true", badge: () => 0 },
        { title: "Merge", run: "true", label: async (ctx) => "Merge #" + (await count(ctx)) },
        { title: "Blank", run: "true", label: () => "  " },
        { title: "Lines", run: "true", label: () => "a\\n".repeat(30) },
      ],
      panels: [
        { title: "Waiting", items: () => [], badge: () => ["a", "b"], summary: () => ["2 to review", "", "1 comment"] },
        { title: "Broken", url: "https://x.dev", badge: () => { throw new Error("tandem isn't running") } },
      ],
    };
  `);
  const base = await loadPatchSet(app, home);
  assert.equal(hasLive(base), true);
  const commands: string[] = [];
  const ctx = { cwd: app, threadId: 't1', run: async (command: string, cwd: string) => { commands.push(command); return runCommand(command, { cwd, env: process.env }); } };
  const set = await applyLive(base, ctx);
  assert.deepEqual(set.actions.map((a) => [a.title, a.badge]), [['Your turn', 3], ['Plain', undefined], ['Zero', undefined], ['Merge #3', undefined], ['Blank', undefined], ['a a a a a a a a a a a a a a a a a a a a a a a a a a a a a a', undefined]]);
  assert.deepEqual(set.actions.map((a) => a.id).slice(-3), ['review.merge', 'review.blank', 'review.lines']);
  assert.deepEqual(set.panels.map((p) => [p.title, p.badge, p.summary]), [['Waiting', 2, '2 to review\n1 comment'], ['Broken', undefined, undefined]]);
  assert.equal(readPatchModule('x', 'project', '/x.ts', { actions: [{ title: 'A', run: 'x', summary: () => 'no' }] }).actions.length, 1);
  for (const a of set.actions) assert.deepEqual(checkAction(a as never), []);
  for (const p of set.panels) assert.deepEqual(checkPanel(p as never), []);
  assert.equal(commands.length, 1);
  assert.equal(set.patches[0]?.liveError, "tandem isn't running");
  // The base set is left as it was, so a when that turns true brings it back.
  assert.equal(base.actions.length, 7);
  assert.equal(base.actions[4]?.title, 'Merge');
  assert.equal(base.patches[0]?.liveError, undefined);
  const without = await loadPatchSet(project(home, 'dev/none'), home);
  assert.equal(hasLive(without), false);
  assert.equal(await applyLive(without, ctx), without);
  assert.equal(readPatchModule('x', 'project', '/x.ts', { actions: [{ title: 'A', run: 'x', when: true }] }).info.error, 'actions[0] ("A") has a when that isn\'t a function.');
});

test('icons on chips: the patch file\'s, unless an action has its own', () => {
  const read = (v: unknown) => readPatchModule('x', 'project', '/p/x.ts', v);
  const ok = read({ icon: ' pawprint ', actions: [{ title: 'Check', run: 'a' }, { title: 'Ship', run: 'b', icon: 'paperplane' }] });
  assert.equal(ok.info.error, undefined);
  assert.deepEqual(ok.actions.map((a) => a.icon), ['pawprint', 'paperplane']);
  assert.equal(read({ actions: [{ title: 'Plain', run: 'a' }] }).actions[0].icon, undefined);
  assert.equal(read({ icon: 3 }).info.error, 'icon should be an SF Symbol name like "film", or a path to a picture or an app.');
  assert.equal(read({ actions: [{ title: 'A', run: 'x', icon: '' }] }).info.error, 'actions[0] ("A"): icon should be an SF Symbol name like "film", or a path to a picture or an app.');
});

test("a patch's icon can be a picture or an app, relative to the patch file; actions and panels without their own get it", async () => {
  const home = tmpDir();
  const tool = project(home, 'dev/tool', { icons: null });
  fs.writeFileSync(path.join(tool, 'icons/tool.png'), 'png');
  const file = writePatch(path.join(tool, '.threadbear/patches'), 'tool.ts', `
    export default {
      icon: "../../icons/tool.png",
      actions: [{ title: "Go", run: "true" }, { title: "Own", run: "true", icon: "star" }],
      panels: [{ title: "List", items: () => [] }, { title: "Docs", url: "https://x.dev", icon: "book" }],
    };
  `);
  const set = await loadPatchSet(tool, home);
  const png = path.join(tool, 'icons/tool.png');
  assert.deepEqual(set.patches, [{ id: 'tool', source: 'project', file, iconFile: png }]);
  assert.deepEqual(set.actions.map((a) => [a.title, a.icon, a.iconFile]), [['Go', undefined, png], ['Own', 'star', undefined]]);
  assert.deepEqual(set.panels.map((p) => [p.title, p.icon, p.iconFile]), [['List', undefined, png], ['Docs', 'book', undefined]]);
  for (const a of set.actions) assert.deepEqual(checkAction(a as never), []);
  for (const p of set.panels) assert.deepEqual(checkPanel(p as never), []);
  const err = (icon: unknown) => readPatchModule('x', 'project', path.join(tool, '.threadbear/patches/x.ts'), { icon }).info.error;
  assert.equal(err('./missing.png'), `icon "./missing.png" isn't there (looked for ${path.join(tool, '.threadbear/patches/missing.png')}).`);
  assert.equal(err('./notes.txt'), 'icon "./notes.txt" should be a .png, .svg, .icns, .pdf, .jpg, .jpeg, .app file.');
  assert.equal(err(''), 'icon should be an SF Symbol name like "film", or a path to a picture or an app.');
  assert.equal(err('film'), undefined);
});
