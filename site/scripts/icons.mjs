#!/usr/bin/env node
// Writes the Phosphor icons the site uses (regular weight, MIT, LICENSE-Phosphor) into
// src/icons as plain SVGs, from any @phosphor-icons/react install on this Mac. Only needed when
// adding an icon: the SVGs are committed. `node scripts/icons.mjs <path to @phosphor-icons/react>`
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkg = process.argv[2];
if (!pkg) throw new Error("Pass the path to an @phosphor-icons/react folder");
const ICONS = {
  "bandaids": "Bandaids", "device-mobile": "DeviceMobile", "link": "Link", "lightning": "Lightning",
  "key": "Key", "lock": "Lock", "shield-check": "ShieldCheck", "terminal-window": "TerminalWindow",
  "github-logo": "GithubLogo", "bell": "Bell", "database": "Database", "moon-stars": "MoonStars",
  "qr-code": "QrCode", "coins": "Coins", "code": "Code", "cursor-click": "CursorClick", "wrench": "Wrench",
  "user-circle": "UserCircle", "git-fork": "GitFork", "desktop": "Desktop", "copy": "Copy", "check": "Check",
  "columns": "Columns", "books": "Books",
  // The docs pages' own icons (site/docs-icons.json).
  "chats-circle": "ChatsCircle", "paper-plane-tilt": "PaperPlaneTilt", "archive": "Archive", "push-pin": "PushPin",
  "stack": "Stack", "clock": "Clock", "users-three": "UsersThree", "keyboard": "Keyboard", "flask": "Flask",
  "plugs-connected": "PlugsConnected", "warning-circle": "WarningCircle", "hard-drives": "HardDrives",
  "lifebuoy": "Lifebuoy", "compass": "Compass", "book-open": "BookOpen",
};
for (const [file, name] of Object.entries(ICONS)) {
  const src = readFileSync(join(pkg, "dist/defs", `${name}.es.js`), "utf8");
  // The "regular" weight is a list of elements; every one of these icons is plain paths.
  const regular = src.split('"regular"')[1].split(/\n\s*\],?\n\s*\[/)[0];
  const paths = [...regular.matchAll(/d: "([^"]+)"/g)].map((m) => `<path d="${m[1]}"/>`).join("");
  if (!paths) throw new Error(`No paths for ${name}`);
  writeFileSync(join("src/icons", `${file}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor">${paths}</svg>\n`);
}
console.log(`Wrote ${Object.keys(ICONS).length} icons.`);
