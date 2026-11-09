#!/usr/bin/env node
// Serves site/dist on http://localhost:5176 the way prod does (worker.mjs and wrangler.jsonc):
// anything that isn't a file gets 404.html with a 404, only GET and HEAD are allowed, and every
// response gets the same headers as prod (headers.mjs). `npm run serve` (HOST and PORT change
// where). Copied from Quick Ask's.
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import { headersFor } from "../headers.mjs";

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".mp4": "video/mp4" };

// The bytes a Range header asks for, as [start, end] (both included); undefined to send the
// whole file, as a header this doesn't understand (several ranges, other units) is ignored; or
// "unsatisfiable" for a 416. Never a range outside the file: an unchecked `bytes=1-0` reached
// createReadStream with start after end, which throws and took the whole server down (Daybreak,
// 8 Nov). Exported for its test.
export function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    // The last n bytes, all of them when n is more than the file has.
    const n = Number(m[2]);
    return n > 0 && size > 0 ? [Math.max(0, size - n), size - 1] : "unsatisfiable";
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : Infinity;
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable";
  return [start, Math.min(end, size - 1)];
}

export function createSiteServer(folder = fileURLToPath(new URL("../dist/", import.meta.url))) {
  // Ending in a slash, so `../dist-other/x` can't pass for being inside it.
  const dist = resolve(folder) + sep;
  // Inside dist once symlinks are followed too. (Worked out per request: dist may not be built yet.)
  const isFile = (file) => file.startsWith(dist) && existsSync(file) && statSync(file).isFile()
    && realpathSync(file).startsWith(realpathSync(dist) + sep);

  function send(req, res, status, file, pathname) {
    const type = types[extname(file)] ?? "application/octet-stream";
    const size = statSync(file).size;
    // Byte ranges, as Cloudflare serves them: Safari won't play a video without them.
    const range = status === 200 ? byteRange(req.headers.range, size) : undefined;
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, ...headersFor(pathname, type) }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    const head = { "Content-Type": type, "Content-Length": range ? end - start + 1 : size, "Accept-Ranges": "bytes", ...headersFor(pathname, type) };
    if (range) head["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : status, head);
    if (req.method === "HEAD" || size === 0) return res.end();
    // A read that fails partway (the file rebuilt under it) ends this response, not the server,
    // and a client that goes away closes the file rather than leaving it open and paused.
    pipeline(createReadStream(file, { start, end }), res, () => {});
  }

  function handle(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end("Bad address"); // `/%E0`: not an address anything could have
      return;
    }
    // Like Cloudflare's html_handling: the .html address redirects to the one without it.
    if (pathname.endsWith(".html")) {
      const clean = pathname === "/index.html" ? "/" : pathname.slice(0, -5);
      res.writeHead(307, { Location: clean }).end();
      return;
    }
    const file = normalize(join(dist, pathname === "/" ? "index.html" : pathname));
    if (isFile(file)) return send(req, res, 200, file, pathname);
    if (isFile(`${file}.html`)) return send(req, res, 200, `${file}.html`, pathname);
    // The 404 page goes through the same check: a 404.html linking out of dist isn't served either.
    const notFound = join(dist, "404.html");
    if (isFile(notFound)) return send(req, res, 404, notFound, pathname);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }

  // Whatever else a request finds, it ends that request, never the server.
  return createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      console.error(e);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end("Server error");
    }
  });
}

// `npm run serve`. Only this Mac can reach it, as `listen(port)` alone took requests from the
// whole network; HOST=0.0.0.0 to try it from a phone.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 5176);
  const host = process.env.HOST ?? "127.0.0.1";
  createSiteServer().listen(port, host, () => console.log(`http://localhost:${port}`));
}
