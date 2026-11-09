#!/usr/bin/env node
// Makes sure a build folder is this account's alone before a script builds in it or trusts
// what's in it: appstore-upload.sh's OUT (archives it may upload) and the derived data it and
// install-phone.sh build with. These used to be fixed names under /tmp, where another account
// on the Mac could make the folder first and plant an archive the upload then signed and sent
// to App Store Connect (Daybreak, 8 Nov), or build products Xcode would reuse.
//
//   OUT=$(node scripts/private-dir.mjs "$OUT")          make it (mode 700) if missing, check it,
//                                                       print its real path for the script to use
//   node scripts/private-dir.mjs --tree "$ARCHIVE"      check everything inside too; makes nothing
//
// A folder passes when nobody else can get into it: it's this account's, its mode gives other
// accounts nothing and no ACL lets anyone in. Every folder above it belongs to this account or
// root and can't be written by anyone else (by mode or ACL), except a root-owned sticky one like
// /tmp, where nobody can move or delete what's ours. All of that is checked on the real path,
// symlinks and `..` resolved by the kernel, and the script then uses that path, so no link on
// the way can be swapped later. Exits 1 with the reason when one doesn't pass.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITABLE_BY_OTHERS = 0o022;
const ANY_ACCESS_BY_OTHERS = 0o077;
const STICKY = 0o1000;
// macOS ACL rights that change a folder or file (`man chmod`, "ACL MANIPULATION OPTIONS").
const WRITE_RIGHTS = new Set(['write', 'add_file', 'add_subdirectory', 'append', 'delete', 'delete_child',
  'writeattr', 'writeextattr', 'writesecurity', 'chown']);

// The folders from / down to `dir`.
function chain(dir) {
  const parts = [];
  for (let p = dir; ; p = dirname(p)) {
    parts.unshift(p);
    if (dirname(p) === p) return parts;
  }
}

// The "allow" entries of macOS ACLs in `ls -le` output, each as its list of rights. Mode bits
// alone miss them: `chmod +a "everyone allow write"` leaves the mode as it was. `ls` prints
// them indented under each file as ` 0: user:someone allow write,append`, and a name may have
// spaces in it (`group:Domain Users`). An entry line this can't read counts as allowing
// everything, so an odd one is refused rather than skipped.
const EVERYTHING = [...WRITE_RIGHTS];
export function aclAllows(lsOutput) {
  const allows = [];
  for (const line of lsOutput.split('\n')) {
    if (!/^\s*\d+: /.test(line)) continue;
    const m = / (?:inherited )?(allow|deny) ([a-z_,]+)\s*$/.exec(line);
    if (!m) allows.push(EVERYTHING);
    else if (m[1] === 'allow') allows.push(m[2].split(','));
  }
  return allows;
}

function acls(args) {
  if (process.platform !== 'darwin') return [];
  const r = spawnSync('/bin/ls', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`couldn't read the ACLs of ${args.at(-1)}: ${r.stderr.trim()}`);
  return aclAllows(r.stdout);
}

function checkFolder(p, uid, last) {
  const st = lstatSync(p);
  // A real path has no links in it; one now means something changed under us.
  if (st.isSymbolicLink()) throw new Error(`${p} changed while it was being checked`);
  if (!st.isDirectory()) throw new Error(`${p} isn't a folder`);
  if (last) {
    if (st.uid !== uid) throw new Error(`${p} belongs to another account (uid ${st.uid})`);
    if (st.mode & ANY_ACCESS_BY_OTHERS) {
      throw new Error(`${p} lets other accounts in (mode ${(st.mode & 0o7777).toString(8)}); move it away so a fresh one is made`);
    }
    if (acls(['-lde', p]).length) throw new Error(`${p} has an ACL letting others in; move it away so a fresh one is made`);
    return;
  }
  if (st.uid !== uid && st.uid !== 0) throw new Error(`${p} belongs to another account (uid ${st.uid})`);
  const shared = (st.mode & WRITABLE_BY_OTHERS) !== 0;
  // Above it, a root-owned sticky folder (/tmp) is fine: nobody else can move what's ours.
  if (shared && (st.uid !== 0 || (st.mode & STICKY) === 0)) {
    throw new Error(`${p} can be written by other accounts (mode ${(st.mode & 0o7777).toString(8)})`);
  }
  if (acls(['-lde', p]).some((rights) => rights.some((r) => WRITE_RIGHTS.has(r)))) {
    throw new Error(`${p} has an ACL letting other accounts write in it`);
  }
}

// Makes `dir` (mode 700) when missing and `make`, checks it and every folder above it on its
// real path, and returns that path, for the caller to use from then on.
//
// Only a folder this made (empty, and private from the start) passes: it leaves MARKER in it,
// and one already there without it is refused. Being private now says nothing about what
// was put in it before (derived data that had been in /tmp, a link out to a shared cache).
export const MARKER = '.made-private';
export function checkPrivateDir(dir, { uid = process.getuid(), make = true } = {}) {
  let made = false;
  const name = basename(dir);
  if (make && name !== '.' && name !== '..') {
    // The folders above are made first, wherever they land, and refused below unless safe.
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    // Then the folder itself, by one mkdir under the real path of what's above it, which says
    // whether this made it: it fails if anything is there already, a link to somewhere included.
    // (Asking first whether it exists can't: something can appear between the asking and here.)
    const parent = realpathSync.native(dirname(dir));
    chain(parent).forEach((p) => checkFolder(p, uid, false));
    try {
      mkdirSync(join(parent, name), { mode: 0o700 });
      made = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  // The kernel's answer (realpath(3)), not path.resolve's: `/tmp/..` is /private to the kernel.
  const real = realpathSync.native(dir);
  const parts = chain(real);
  parts.forEach((p, i) => checkFolder(p, uid, i === parts.length - 1));
  const marker = join(real, MARKER);
  if (made) {
    writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
  } else {
    const st = lstatSync(marker, { throwIfNoEntry: false });
    if (!st?.isFile() || st.uid !== uid) {
      throw new Error(`${real} wasn't made by these scripts; move it away so a fresh one is made`);
    }
  }
  return real;
}

// Everything inside `dir` (an archive about to be reused) is this account's, can't be written
// by anyone else, by mode or ACL, and any link in it stays inside it.
// It sits in a private folder (OUT), so it needn't be one itself, as Xcode makes it.
export function checkPrivateTree(dir, { uid = process.getuid() } = {}) {
  // Not a link itself: the script goes on using this path, and a link could lead elsewhere later.
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link`);
  const root = realpathSync.native(dir);
  checkPrivateDir(dirname(root), { uid, make: false });
  const top = lstatSync(root);
  if (!top.isDirectory()) throw new Error(`${root} isn't a folder`);
  if (top.uid !== uid) throw new Error(`${root} belongs to another account (uid ${top.uid})`);
  if (top.mode & WRITABLE_BY_OTHERS) throw new Error(`${root} can be written by other accounts`);
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const child = join(p, name);
      const st = lstatSync(child);
      if (st.uid !== uid) throw new Error(`${child} belongs to another account (uid ${st.uid})`);
      if (st.isSymbolicLink()) {
        // Only links that go down from where they are (`Current -> A`): one through `..` or an
        // absolute path could pass through a folder someone else can change, even if it ends
        // up back inside today.
        const target = readlinkSync(child);
        if (target.startsWith('/') || target.split('/').includes('..')) throw new Error(`${child} links out through ${target}`);
        let to;
        try {
          to = realpathSync.native(child);
        } catch {
          throw new Error(`${child} is a link to nothing`);
        }
        if (to !== root && !to.startsWith(root + sep)) throw new Error(`${child} links outside ${root}`);
        continue;
      }
      if (st.mode & WRITABLE_BY_OTHERS) throw new Error(`${child} can be written by other accounts`);
      if (st.isDirectory()) walk(child);
    }
  };
  walk(root);
  if (acls(['-laeR', root]).some((rights) => rights.some((r) => WRITE_RIGHTS.has(r)))) {
    throw new Error(`something in ${root} has an ACL letting other accounts write it`);
  }
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tree = args[0] === '--tree';
  const dir = tree ? args[1] : args[0];
  if (!dir || args.length !== (tree ? 2 : 1)) {
    console.error(`usage: ${process.argv[1].split(sep).pop()} [--tree] <dir>`);
    process.exit(2);
  }
  try {
    console.log((tree ? checkPrivateTree : checkPrivateDir)(dir));
  } catch (e) {
    console.error(`Not using it: ${e.message}`);
    process.exit(1);
  }
}
