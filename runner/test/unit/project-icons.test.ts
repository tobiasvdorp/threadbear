import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { Projects, projectMethods } from '../../src/projects.ts';
import { Librarian, ICON_SOON_MS, ICON_SWEEP_MS } from '../../src/librarian.ts';
import { findIcon, imageSize, phonePicture, storeIcon, SYMBOLS } from '../../src/project-icons.ts';
import { magickCommand, pictureKind, svgToPng } from '../../src/images.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';

// A real PNG of one colour, so sips can read it.
function png(w: number, h: number, rgb: [number, number, number] = [200, 80, 40]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function folder(root: string, rel: string, files: Record<string, string | Buffer>): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("finding an icon: the app icon over favicons and logos, never another thing's", async () => {
  const root = tmpDir();
  const app = folder(root, 'poddle', {
    'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png': png(1024, 1024),
    'App/Assets.xcassets/Icons/icon-gear.imageset/icon.png': png(1024, 1024),
    'web/public/favicon-32.png': png(32, 32),
    'web/public/logo.png': png(600, 120),
    'docs/mockups/app-icon.png': png(1024, 1024),
    'node_modules/x/icon.png': png(1024, 1024),
  });
  assert.equal((await findIcon([app]))?.path, path.join(app, 'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png'));

  // A web app: the apple-touch-icon over the favicon and the wide logo.
  const web = folder(root, 'blog', { 'public/favicon.ico': 'x', 'public/apple-touch-icon.png': png(180, 180), 'public/logo.png': png(600, 120) });
  assert.equal((await findIcon([web]))?.path, path.join(web, 'public/apple-touch-icon.png'));

  // A Chrome extension: its manifest's biggest icon.
  const ext = folder(root, 'new-tab', {
    'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '16': 'art/i16.png', '128': 'art/i128.png' } }),
    'art/i16.png': png(16, 16),
    'art/i128.png': png(128, 128),
  });
  assert.equal((await findIcon([ext]))?.path, path.join(ext, 'art/i128.png'));

  // A picture named after the project in an icons folder.
  const named = folder(root, 'threadbear', { 'app/icons/threadbear.png': png(1024, 1024) });
  assert.equal((await findIcon([named]))?.path, path.join(named, 'app/icons/threadbear.png'));

  // Under a folder named for something else, it's that thing's icon.
  const other = folder(root, 'cannvas', { 'public/inventory/icon.svg': '<svg viewBox="0 0 512 512"></svg>' });
  assert.equal(await findIcon([other]), undefined);
  assert.equal(await findIcon([folder(root, 'nothing', { 'src/a.ts': '' })]), undefined);

  assert.deepEqual(await imageSize(path.join(other, 'public/inventory/icon.svg'), '.svg'), { width: 512, height: 512 });
  assert.ok(SYMBOLS.includes('film') && new Set(SYMBOLS).size === SYMBOLS.length);
});

function setup(models?: (p: GenerateParams) => ModelResult<string>) {
  const root = tmpDir();
  const home = tmpDir();
  const clock = new FakeClock();
  const projects = new Projects({ home, clock, log: nullLogger, userHome: root });
  const asked: GenerateParams[] = [];
  const h = makeHarness(home, {}, { projects, panelsRoot: root });
  projects.start(h.runner);
  const librarian = new Librarian({
    host: h.runner,
    projects,
    models: models && { generate: async (p: GenerateParams) => (asked.push(p), models(p)) },
    clock,
    log: nullLogger,
    home,
    userHome: root,
  });
  librarian.start();
  // Lets the icon timer fire and its run finish.
  const settle = async (ms = ICON_SOON_MS) => {
    clock.advance(ms);
    await librarian.keepIcons();
    await tick(4);
  };
  return { h, root, home, clock, projects, librarian, asked, settle };
}

test('the librarian copies a project icon in, follows the file when it changes, and takes it away with the project', async () => {
  const s = setup();
  const app = folder(s.root, 'walkies', { 'Walkies/Assets.xcassets/AppIcon.appiconset/AppIcon.png': png(1024, 1024) });
  const p = s.projects.create({ title: 'Walkies', folders: [app], by: 'mike' });
  await s.settle();
  const icon = s.projects.list()[0].icon!;
  assert.equal(icon.by, 'librarian');
  assert.equal(icon.from, path.join(app, 'Walkies/Assets.xcassets/AppIcon.appiconset/AppIcon.png'));
  assert.equal(path.dirname(icon.image!.path), s.projects.iconDir);
  assert.equal(icon.image!.mediaType, 'image/png');
  // Made small, for a 16 pt dot.
  assert.equal(icon.image!.width, 256);
  assert.ok(!('hash' in icon), 'the hash stays in the runner');

  // Nothing changed: the same copy.
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon!.image!.path, icon.image!.path);

  // A new icon in the repo: the next sweep copies it, and the old copy goes.
  fs.writeFileSync(icon.from!, png(512, 512, [10, 120, 200]));
  await s.settle(ICON_SWEEP_MS);
  const next = s.projects.list()[0].icon!;
  assert.notEqual(next.image!.path, icon.image!.path);
  assert.deepEqual(fs.readdirSync(s.projects.iconDir), [path.basename(next.image!.path)]);

  s.projects.delete(p.id);
  assert.deepEqual(fs.readdirSync(s.projects.iconDir), []);
  s.librarian.stop();
});

test('a project with no picture gets a symbol from the list; a made-up one is ignored', async () => {
  let answer = 'film';
  const s = setup((p) => {
    assert.match(p.prompt, /^Project "Scheduled jobs"/);
    assert.match(p.prompt, /Symbols: app macwindow/);
    return { ok: true, value: answer, model: 'haiku' };
  });
  answer = 'not.a.symbol';
  s.projects.create({ title: 'Scheduled jobs', by: 'librarian' });
  await s.settle();
  assert.equal(s.projects.list()[0].icon, undefined);
  answer = '"calendar".';
  await s.settle(ICON_SWEEP_MS);
  assert.deepEqual([s.projects.list()[0].icon?.symbol, s.projects.list()[0].icon?.by], ['calendar', 'librarian']);
  // Once it has one, it isn't asked again.
  const n = s.asked.length;
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.asked.length, n);
  s.librarian.stop();
});

test("Mike's and agents' choices stay until set back to automatic", async () => {
  const s = setup(() => ({ ok: true, value: 'hammer', model: 'haiku' }));
  const app = folder(s.root, 'tandem', { 'icons/tandem.png': png(300, 300) });
  const mine = path.join(s.root, 'mine.png');
  fs.writeFileSync(mine, png(64, 64));
  const p = s.projects.create({ title: 'Tandem', folders: [app], by: 'mike' });
  const m = projectMethods(s.projects);

  const chosen = (await m['projects.setIcon']({ projectId: p.id, path: mine })) as { project: { icon: { by: string; from: string; image: { width: number } } } };
  assert.deepEqual([chosen.project.icon.by, chosen.project.icon.from, chosen.project.icon.image.width], ['mike', mine, 64]);
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon!.from, mine);

  await assert.rejects(Promise.resolve().then(() => m['projects.setIcon']({ projectId: p.id, symbol: 'Not A Symbol!' })), /Not an SF Symbol/);
  await assert.rejects(Promise.resolve().then(() => m['projects.setIcon']({ projectId: p.id, path: '/nope.png' })), /Picture not found/);

  // An agent, through update_project.
  const { thread } = s.h.runner.create({ text: 'hi', cwd: app, accountId: 'claude-3' });
  const tools = buildThreadbearTools(s.h.runner, thread.id, Date.now, undefined, s.projects);
  const update = tools.find((t) => t.name === 'update_project')!;
  await update.handler({ project: 'Tandem', icon: 'film' } as never, {} as never);
  assert.deepEqual([s.projects.list()[0].icon?.symbol, s.projects.list()[0].icon?.by], ['film', 'agent']);
  await s.settle(ICON_SWEEP_MS);
  assert.equal(s.projects.list()[0].icon?.symbol, 'film');

  // Automatic again: the librarian finds the repo's own.
  await update.handler({ project: 'Tandem', icon: 'auto' } as never, {} as never);
  assert.equal(s.projects.list()[0].icon, undefined);
  await s.settle();
  assert.deepEqual([s.projects.list()[0].icon?.by, s.projects.list()[0].icon?.from], ['librarian', path.join(app, 'icons/tandem.png')]);
  s.librarian.stop();
});

test('the phone gets a PNG as it is and an SVG drawn to a 256 px PNG', async () => {
  const dir = tmpDir();
  const pngPath = path.join(dir, 'p1-aaa.png');
  fs.writeFileSync(pngPath, png(8, 8));
  const asIs = await phonePicture(pngPath, 'image/png');
  assert.equal(asIs.mediaType, 'image/png');
  assert.deepEqual(Buffer.from(asIs.bytes), png(8, 8));
  const svgPath = path.join(dir, 'p1-bbb.svg');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#38f"/></svg>');
  const drawn = await phonePicture(svgPath, 'image/svg+xml');
  assert.equal(drawn.mediaType, 'image/png');
  const drawnPath = path.join(dir, 'drawn.png');
  fs.writeFileSync(drawnPath, drawn.bytes);
  assert.deepEqual(await imageSize(drawnPath, '.png'), { width: 256, height: 256 });
  await assert.rejects(phonePicture(path.join(dir, 'missing.png'), 'image/png'));
  await assert.rejects(phonePicture(pngPath, 'image/x-icon'), /can't show/);
});

// Daybreak, 8 Nov ("Linux icon conversion can execute repository-supplied
// MSL"): a repo's manifest.json named icon.msl, the librarian picked it, and
// on Linux it went to ImageMagick, which chose its MSL decoder for it: a
// script that writes files.
const MSL = '<?xml version="1.0" encoding="UTF-8"?>\n<image><read filename="/etc/hosts"/><write filename="/tmp/tb-pwned.txt"/></image>\n';

test("a manifest's icon has to be a picture of the repo's own: not a script, not a link out of it", async () => {
  const root = tmpDir();
  const msl = folder(root, 'evil-ext', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'icon.msl' } }), 'icon.msl': MSL });
  assert.equal(await findIcon([msl]), undefined);
  const mvg = folder(root, 'evil-expo', { 'app.json': JSON.stringify({ expo: { icon: './icon.mvg' } }), 'icon.mvg': 'push graphic-context' });
  assert.equal(await findIcon([mvg]), undefined);
  // A link to a file outside, named like a picture.
  const secret = path.join(root, 'secret.png');
  fs.writeFileSync(secret, png(128, 128));
  const linked = folder(root, 'linked-ext', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'icon.png' } }) });
  fs.symlinkSync(secret, path.join(linked, 'icon.png'));
  assert.equal(await findIcon([linked]), undefined);
  // Through a linked folder.
  const viaDir = folder(root, 'via-dir', { 'manifest.json': JSON.stringify({ manifest_version: 3, icons: { '128': 'art/secret.png' } }) });
  fs.symlinkSync(root, path.join(viaDir, 'art'));
  assert.equal(await findIcon([viaDir]), undefined);
});

test('ImageMagick is only ever handed a picture, with its decoder named', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'out.png');
  const write = (name: string, body: string | Buffer) => (fs.writeFileSync(path.join(dir, name), body), path.join(dir, name));
  // A script, whatever it's called.
  for (const name of ['icon.msl', 'icon.png', 'icon.svg', 'icon.mvg']) assert.equal(magickCommand('/usr/bin/magick', write(name, MSL), out, { format: 'png' }), undefined, name);
  assert.equal(magickCommand('/usr/bin/magick', write('text.png', 'push graphic-context\nviewbox 0 0 1 1'), out, { format: 'png' }), undefined);
  // A real PNG, even one named otherwise, goes to the PNG decoder by name.
  const real = write('real.msl', png(8, 8));
  const cmd = magickCommand('/usr/bin/magick', real, out, { format: 'png', maxPx: 256 });
  assert.equal(cmd?.[1][0], `png:${real}[0]`);
  assert.equal(cmd?.[1].at(-1), `png:${out}`);
  assert.equal(pictureKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(pictureKind(Buffer.from('\0\0\0\x18ftypheic', 'latin1')), 'heic');
  assert.equal(pictureKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(pictureKind(Buffer.from('<?xml', 'latin1')), undefined);
});

test("storing an icon that isn't a picture by its bytes is refused, not copied or converted", async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'icon.png');
  fs.writeFileSync(src, MSL);
  await assert.rejects(storeIcon(src, path.join(dir, 'icons'), 'p1', 'h'), /Not a picture/);
  assert.ok(!fs.existsSync(path.join(dir, 'icons', 'p1-h.png')));
});

test('an SVG is never drawn by ImageMagick on Linux', { skip: process.platform === 'darwin' }, async () => {
  // In a process of its own: images.ts remembers what it found on PATH, and
  // this one's PATH has only a magick that notes it ran.
  const dir = tmpDir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'magick'), `#!/bin/sh\ntouch ${JSON.stringify(path.join(dir, 'ran'))}\n`, { mode: 0o755 });
  const svg = path.join(dir, 'a.svg');
  fs.writeFileSync(svg, '<svg viewBox="0 0 1 1"><image href="msl:/tmp/x.msl"/></svg>');
  const images = new URL('../../src/images.ts', import.meta.url).href;
  const script = `const { svgToPng } = await import(${JSON.stringify(images)}); console.log(await svgToPng(${JSON.stringify(svg)}, ${JSON.stringify(path.join(dir, 'a.png'))}, 64));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(out.trim(), 'false');
  assert.ok(!fs.existsSync(path.join(dir, 'ran')), 'ImageMagick was not run');
});
