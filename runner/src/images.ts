// Converting, shrinking and drawing images, for pasted photos (media.ts)
// and project pictures (project-icons.ts). macOS has all of it built in:
// sips and Quick Look. A runner on Linux uses ImageMagick (`magick`, or
// `convert` on ImageMagick 6) for pictures and rsvg-convert for SVG
// instead, which INSTALL.md ("A runner on Linux") installs. Without them every call here fails the
// way a picture sips couldn't read does, so callers keep their fallbacks.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAC = process.platform === 'darwin';

export interface ConvertOptions {
  format: 'png' | 'jpeg';
  // JPEG quality, 0 to 100.
  quality?: number;
  // Shrinks the picture to fit this many pixels on its longer side.
  maxPx?: number;
}

// The first of `names` on PATH, or undefined. Looked up once per name.
const found = new Map<string, string | undefined>();
function onPath(...names: string[]): string | undefined {
  for (const name of names) {
    if (!found.has(name)) {
      let hit: string | undefined;
      for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, name);
        try {
          fs.accessSync(p, fs.constants.X_OK);
          hit = p;
          break;
        } catch {
          // not here
        }
      }
      found.set(name, hit);
    }
    const hit = found.get(name);
    if (hit) return hit;
  }
  return undefined;
}

// Which picture format a file's own first bytes say it is, as ImageMagick
// names the decoder for it; undefined for anything else. Pictures come from
// repos (project icons) and wherever a CLI or a paste found them, and left to
// itself ImageMagick picks its decoder from the name and the bytes, among
// them MSL and MVG, its own scripting languages, which read and write any
// file the runner can (Daybreak, 8 Nov: a repo's manifest.json naming an
// icon.msl). So it's only ever handed one of these, named outright.
export type PictureKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'ico' | 'heic' | 'avif' | 'icns';

export function pictureKind(head: Buffer): PictureKind | undefined {
  const at = (i: number, s: string) => head.length >= i + s.length && head.toString('latin1', i, i + s.length) === s;
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'II*\x00') || at(0, 'MM\x00*')) return 'tiff';
  if (at(0, 'BM')) return 'bmp';
  if (at(0, '\x00\x00\x01\x00')) return 'ico';
  if (at(0, 'icns')) return 'icns';
  if (at(4, 'ftyp')) {
    const brand = head.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return undefined;
}

export function pictureKindOf(file: string): PictureKind | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(32);
    return pictureKind(buf.subarray(0, fs.readSync(fd, buf, 0, 32, 0)));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The command that converts `src` into `out`, or undefined when this
// machine has nothing that can (on Linux, nothing for what `src` is).
export function convertCommand(src: string, out: string, o: ConvertOptions): [string, string[]] | undefined {
  if (MAC) {
    return [
      '/usr/bin/sips',
      [
        '-s', 'format', o.format,
        ...(o.format === 'jpeg' && o.quality !== undefined ? ['-s', 'formatOptions', String(o.quality)] : []),
        ...(o.maxPx ? ['-Z', String(o.maxPx)] : []),
        src, '--out', out,
      ],
    ];
  }
  const magick = onPath('magick', 'convert');
  return magick ? magickCommand(magick, src, out, o) : undefined;
}

// ImageMagick's command for it. Nothing that isn't a picture by its bytes
// goes to it at all (pictureKind), nor an .icns, which it has no decoder for.
export function magickCommand(magick: string, src: string, out: string, o: ConvertOptions): [string, string[]] | undefined {
  const kind = pictureKindOf(src);
  if (!kind || kind === 'icns') return undefined;
  return [
    magick,
    [
      // The decoder named, so ImageMagick never picks one itself; [0]: the
      // first frame or page only, as sips does for a GIF or TIFF.
      `${kind}:${src}[0]`,
      // Phone photos are often stored sideways with a turn-me tag, which
      // sips applies; ImageMagick needs telling.
      '-auto-orient',
      // ">" only ever shrinks, like -Z on the callers' already-too-big images.
      ...(o.maxPx ? ['-resize', `${o.maxPx}x${o.maxPx}>`] : []),
      ...(o.format === 'jpeg' && o.quality !== undefined ? ['-quality', String(o.quality)] : []),
      `${o.format}:${out}`,
    ],
  ];
}

// Converts `src` into `out`. Throws when it can't.
export function convertImageSync(src: string, out: string, o: ConvertOptions, timeoutMs = 30_000): void {
  const cmd = convertCommand(src, out, o);
  if (!cmd) throw new Error('No image converter on this machine (sips, or ImageMagick on Linux)');
  execFileSync(cmd[0], cmd[1], { stdio: 'ignore', timeout: timeoutMs });
}

// convertImageSync without blocking: true when `out` was made.
export function convertImage(src: string, out: string, o: ConvertOptions, timeoutMs = 20_000): Promise<boolean> {
  const cmd = convertCommand(src, out, o);
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => execFile(cmd[0], cmd[1], { timeout: timeoutMs }, (err) => resolve(!err && fs.existsSync(out))));
}

// Draws an SVG to a PNG at `out`, fitting `px` square. Quick Look on macOS,
// which names its own output, so the file is moved to `out`; rsvg-convert
// on Linux. Not ImageMagick: its SVG reader follows an <image> in the file
// to any decoder, MSL included, and these come from repos.
// True when `out` was made.
export async function svgToPng(src: string, out: string, px: number, timeoutMs = 20_000): Promise<boolean> {
  const run = (cmd: string, args: string[]) =>
    new Promise<boolean>((resolve) => execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(!err)));
  if (MAC) {
    const dir = path.dirname(out);
    if (!(await run('/usr/bin/qlmanage', ['-t', '-s', String(px), '-o', dir, src]))) return false;
    const made = path.join(dir, path.basename(src) + '.png');
    if (!fs.existsSync(made)) return false;
    if (made !== out) await fs.promises.rename(made, out);
    return true;
  }
  const rsvg = onPath('rsvg-convert');
  if (rsvg) return (await run(rsvg, ['-w', String(px), '-h', String(px), '--keep-aspect-ratio', '-o', out, src])) && fs.existsSync(out);
  return false;
}
