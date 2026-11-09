// ios/scripts/appstore-upload.sh only builds and trusts archives in folders that are this
// account's alone (Daybreak, 8 Nov: another account could make the /tmp folder first and plant an
// archive the upload then signed and sent). The checks are in ios/scripts/private-dir.mjs; the
// script runs here with a fake xcodebuild that records what it was asked to do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs without types
import { aclAllows, checkPrivateDir, checkPrivateTree } from '../../../ios/scripts/private-dir.mjs';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const script = join(repo, 'ios/scripts/appstore-upload.sh');
const base = mkdtempSync(join(tmpdir(), 'tb-appstore-'));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(base, `case-${n++}`);
  mkdirSync(d, { mode: 0o700 });
  return d;
};
const uid = process.getuid!();

test('makes a missing folder for this account only', () => {
  const dir = join(fresh(), 'a/b');
  checkPrivateDir(dir);
  assert.ok(existsSync(dir));
});

test('refuses a folder another account made first', () => {
  // The attack: someone else's uid owns the folder (or one above it) before the operator runs.
  const dir = join(fresh(), 'out');
  mkdirSync(dir);
  assert.throws(() => checkPrivateDir(dir, { uid: uid + 1 }), /another account/);
  assert.throws(() => checkPrivateDir(join(dir, 'build'), { uid: uid + 1 }), /another account/);
});

test('refuses a folder, or one above it, that others can write', () => {
  const parent = join(fresh(), 'shared');
  mkdirSync(parent);
  chmodSync(parent, 0o777);
  assert.throws(() => checkPrivateDir(parent), /lets other accounts in/);
  assert.throws(() => checkPrivateDir(join(parent, 'out')), /written by other accounts/);
  // Sticky isn't enough unless root owns it (as /tmp).
  chmodSync(parent, 0o1777);
  assert.throws(() => checkPrivateDir(join(parent, 'out')), /written by other accounts/);
});

test('refuses a folder other accounts can look into', () => {
  // Nothing in it would be checked again (derived data is too big to), so nobody else may reach it.
  const dir = join(fresh(), 'dd');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  assert.throws(() => checkPrivateDir(dir), /lets other accounts in/);
});

test('checks, and hands back, the real path a symlink leads to', () => {
  const root = fresh();
  const shared = join(root, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  symlinkSync(shared, join(root, 'link'));
  assert.throws(() => checkPrivateDir(join(root, 'link')), /lets other accounts in/);
  // A link through a folder others can write to a private one: the script is handed the private
  // folder's real path, so swapping the link afterwards changes nothing.
  const good = join(root, 'good');
  checkPrivateDir(good);
  mkdirSync(join(good, 'sub'));
  symlinkSync(good, join(shared, 'relay'));
  symlinkSync(join(shared, 'relay'), join(root, 'out'));
  assert.equal(checkPrivateDir(join(root, 'out')), realpathSync(good));
  // And `..` the way the kernel follows it, not path.resolve: `out/..` is good's parent.
  assert.equal(checkPrivateDir(join(root, 'out', 'sub', '..')), realpathSync(good));
});

// An archive in an OUT the script made.
const newArchive = () => join(checkPrivateDir(join(fresh(), 'out')), 'Threadbear.xcarchive');

test('refuses an archive with something in it that others could have written', () => {
  const archive = newArchive();
  mkdirSync(join(archive, 'Products'), { recursive: true, mode: 0o700 });
  writeFileSync(join(archive, 'Info.plist'), 'x', { mode: 0o600 });
  checkPrivateTree(archive);
  assert.throws(() => checkPrivateTree(archive, { uid: uid + 1 }), /another account/);
  chmodSync(join(archive, 'Info.plist'), 0o666);
  assert.throws(() => checkPrivateTree(archive), /written by other accounts/);
});

test('refuses an archive with a link out of it, or through anywhere else', () => {
  const archive = newArchive();
  const root = join(archive, '..');
  mkdirSync(join(archive, 'Products/A'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'elsewhere'), { mode: 0o700 });
  symlinkSync('A', join(archive, 'Products', 'Current'));
  checkPrivateTree(archive);
  symlinkSync(join(root, 'elsewhere'), join(archive, 'Products', 'Threadbear.app'));
  assert.throws(() => checkPrivateTree(archive), /links out/);
  rmSync(join(archive, 'Products', 'Threadbear.app'));
  // Back inside in the end, but by way of a folder outside that someone could change later.
  symlinkSync('../../elsewhere/../Threadbear.xcarchive/Products/A', join(archive, 'Products', 'B'));
  assert.throws(() => checkPrivateTree(archive), /links out/);
  rmSync(join(archive, 'Products', 'B'));
  symlinkSync(join(archive, 'Products', 'A'), join(archive, 'Products', 'B'));
  assert.throws(() => checkPrivateTree(archive), /links out/);
  rmSync(join(archive, 'Products', 'B'));
  checkPrivateTree(archive);
  // Nor is the archive itself a link.
  const real = join(root, 'real.xcarchive');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(root, 'linked.xcarchive'));
  assert.throws(() => checkPrivateTree(join(root, 'linked.xcarchive')), /is a link/);
});

test('refuses a private folder these scripts did not make', () => {
  // Derived data from when it was in /tmp, say: private now, but who knows what's in it.
  const dir = join(fresh(), 'dd');
  mkdirSync(dir, { mode: 0o700 });
  assert.throws(() => checkPrivateDir(dir), /wasn't made by these scripts/);
  const made = join(fresh(), 'dd');
  checkPrivateDir(made);
  checkPrivateDir(made);
});

test('reads ACL entries, names with spaces too, and counts odd ones as allowing everything', () => {
  assert.deepEqual(aclAllows(' 0: group:everyone deny delete\n'), []);
  assert.deepEqual(aclAllows(' 0: user:someone allow write,append\n'), [['write', 'append']]);
  assert.deepEqual(aclAllows(' 0: group:Domain Users allow list,search,add_file\n'), [['list', 'search', 'add_file']]);
  assert.deepEqual(aclAllows(' 1: group:Domain Users inherited allow add_file,file_inherit\n'), [['add_file', 'file_inherit']]);
  assert.equal(aclAllows(' 0: something we have never seen\n')[0]!.includes('write'), true);
  assert.deepEqual(aclAllows('drwx------  3 me  staff  96 Nov  8 22:00 a folder allow write\n'), []);
});

// ACLs are macOS's; mode bits don't show them.
const acl = process.platform === 'darwin';
const chmodAcl = (entry: string, file: string) => assert.equal(spawnSync('/bin/chmod', ['+a', entry, file]).status, 0);

test('refuses a folder with an ACL letting anyone in', { skip: !acl && 'macOS ACLs' }, () => {
  const dir = join(fresh(), 'out');
  checkPrivateDir(dir);
  chmodAcl('everyone allow list,search', dir);
  assert.throws(() => checkPrivateDir(dir), /ACL/);
});

test('refuses a folder above with an ACL letting others write', { skip: !acl && 'macOS ACLs' }, () => {
  const parent = join(fresh(), 'parent');
  mkdirSync(parent, { mode: 0o700 });
  chmodAcl('everyone allow add_subdirectory,delete_child', parent);
  assert.throws(() => checkPrivateDir(join(parent, 'out')), /ACL/);
});

test('refuses an archive with a file an ACL lets others write', { skip: !acl && 'macOS ACLs' }, () => {
  const archive = newArchive();
  mkdirSync(join(archive, 'Products'), { recursive: true, mode: 0o700 });
  writeFileSync(join(archive, 'Products', 'Threadbear'), 'x', { mode: 0o600 });
  checkPrivateTree(archive);
  chmodAcl('everyone allow write', join(archive, 'Products', 'Threadbear'));
  assert.throws(() => checkPrivateTree(archive), /ACL/);
});

// The script itself: zsh, PlistBuddy and strings, so on a Mac only.
const mac = process.platform === 'darwin' && existsSync('/usr/libexec/PlistBuddy');

function setup() {
  const root = fresh();
  const bin = join(root, 'bin');
  const keys = join(root, 'keys');
  mkdirSync(bin);
  mkdirSync(keys);
  writeFileSync(join(keys, 'AuthKey_TESTKEY.p8'), 'not a key');
  const calls = join(root, 'calls.log');
  // Records each call; archiving fails (so a test stops there), and so does exporting.
  writeFileSync(join(bin, 'xcodebuild'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  return { root, bin, keys, calls };
}

// What an attacker would plant: an archive that passes every content check in the script.
function plant(out: string, finished: boolean) {
  const app = join(out, 'Threadbear.xcarchive/Products/Applications/Threadbear.app');
  mkdirSync(app, { recursive: true });
  const plist = (file: string, dict: string) =>
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${dict}</dict></plist>`);
  plist(
    join(out, 'Threadbear.xcarchive/Info.plist'),
    '<key>ApplicationProperties</key><dict><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleVersion</key><string>7</string></dict>',
  );
  plist(join(app, 'Info.plist'), '<key>ThreadbearAPSEnvironment</key><string>production</string>');
  writeFileSync(join(app, 'Threadbear'), 'planted');
  writeFileSync(join(app, 'PrivacyInfo.xcprivacy'), '');
  if (finished) writeFileSync(join(out, 'archived.txt'), 'archived from commit abc');
}

function run(env: Record<string, string>, s: ReturnType<typeof setup>) {
  const r = spawnSync('/bin/zsh', [script], {
    env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:${process.env.PATH}`, HOME: s.root, KEY_DIR: s.keys, ASC_KEY_ID: 'TESTKEY', DD: join(s.root, 'dd'), ...env },
    encoding: 'utf8',
  });
  const calls = existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '';
  return { ...r, calls };
}

test('an archive already in OUT is built afresh unless BUILD_NUMBER asks for it', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const out = join(s.root, 'out');
  checkPrivateDir(out);
  plant(out, true);
  const r = run({ OUT: out }, s);
  assert.notEqual(r.status, 0);
  assert.match(r.calls, /^archive /m, r.stdout + r.stderr);
  assert.doesNotMatch(r.calls, /-exportArchive/);
  assert.doesNotMatch(r.stdout, /Using the archive/);
});

test('refuses to reuse from a folder others can write', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const out = join(s.root, 'out');
  mkdirSync(out);
  plant(out, true);
  chmodSync(out, 0o777);
  const r = run({ OUT: out, BUILD_NUMBER: '7' }, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lets other accounts in/);
  assert.equal(r.calls, '');
});

test('refuses to reuse an archive the script never finished', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const out = join(s.root, 'out');
  checkPrivateDir(out);
  plant(out, false);
  const r = run({ OUT: out, BUILD_NUMBER: '7' }, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /wasn't finished by this script/);
  assert.equal(r.calls, '');
});

test('refuses to reuse an archive with a file others can write', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const out = join(s.root, 'out');
  checkPrivateDir(out);
  plant(out, true);
  chmodSync(join(out, 'Threadbear.xcarchive/Products/Applications/Threadbear.app/Threadbear'), 0o666);
  const r = run({ OUT: out, BUILD_NUMBER: '7' }, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /written by other accounts/);
  assert.equal(r.calls, '');
});

test('reuses its own finished archive when BUILD_NUMBER names it', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const out = join(s.root, 'out');
  checkPrivateDir(out);
  plant(out, true);
  const r = run({ OUT: out, BUILD_NUMBER: '7' }, s);
  assert.match(r.stdout, /Using the archive already at/);
  assert.doesNotMatch(r.calls, /^archive /m);
  assert.match(r.calls, /-exportArchive/);
});

test('the default folders are private ones under the home folder', { skip: !mac && 'needs macOS' }, () => {
  const s = setup();
  const r = run({ DD: '' }, s);
  const home = realpathSync(s.root);
  assert.match(r.calls, new RegExp(`-archivePath ${home}/Library/Caches/Threadbear/ios-builds/appstore/\\d{10}/Threadbear.xcarchive`));
  assert.match(r.calls, new RegExp(`-derivedDataPath ${home}/Library/Caches/Threadbear/ios-builds/dd-appstore`));
});

test('a link put where the folder is about to be made is not taken for a new folder', () => {
  // Codex, third look: the folder was "new" if it wasn't there a moment before, so a link
  // dropped in at the right moment to an old private folder of ours got the marker.
  const root = fresh();
  const legacy = join(root, 'legacy-dd');
  mkdirSync(legacy, { mode: 0o700 });
  symlinkSync(legacy, join(root, 'dd'));
  assert.throws(() => checkPrivateDir(join(root, 'dd')), /wasn't made by these scripts/);
  assert.equal(existsSync(join(legacy, '.made-private')), false);
});
