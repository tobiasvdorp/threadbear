// Ported from Agent Archive's shared/redaction.test.ts: each mangled key below
// is one that really got past an earlier version of these rules.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import test from "node:test";

import { HELD_BACK, redactSecrets, scrubDoc, scrubText, SCRUB_RULES_VERSION } from "../../src/redaction.ts";

// Count parser work without charging it for time the Mac gives other processes.
function redactionCpuMs(text: string): number {
  const started = process.cpuUsage();
  redactSecrets(text);
  const { user, system } = process.cpuUsage(started);
  return (user + system) / 1000;
}

const KEY = "[REDACTED PRIVATE KEY]";
const END = "-----END PRIVATE KEY-----";

// The PKCS#8 header every P-256 key starts with, so the first line begins
// MIGTAgEAMBMG like a real .p8 key's.
const P256_PKCS8_HEADER = Buffer.from(
  "308193020100301306072a8648ce3d020106082a8648ce3d030107047930770201010420",
  "hex",
);

// The body of an Apple .p8 key is 150 bytes: lines of 64, 64, 64 and 8
// base64 characters. After the header these are hashes, not key material.
function fakeP8Body(seed: string): string[] {
  const bytes = Buffer.concat([
    P256_PKCS8_HEADER,
    ...[0, 1].map((part) =>
      createHash("sha512").update(`${seed}:${part}`).digest(),
    ),
  ]).subarray(0, 150);
  return bytes.toString("base64").match(/.{1,64}/g) ?? [];
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Asserts that redaction removed exactly the key lines: every other word,
// quotes included, is still there in the same order.
function assertOnlyKeyLinesRemoved(input: string, keyLines: string[]): string {
  const { text } = redactSecrets(input);
  for (const line of keyLines) {
    assert.equal(text.includes(line), false, line);
  }
  assert.deepEqual(
    words(text.replaceAll(KEY, " ")),
    words(input).filter((word) => !keyLines.includes(word)),
  );
  return text;
}

// A throwaway P-256 key, generated per run, without its BEGIN line.
function beginlessPem(): { text: string; lines: string[] } {
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const text = pem.slice(pem.indexOf("\n") + 1);
  const lines = text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("-----"));
  return { text, lines };
}

test("more provider token shapes are redacted", () => {
  const samples = [
    `hf_${"a".repeat(34)}`,
    `SG.${"b".repeat(22)}.${"c".repeat(43)}`,
    `glpat-${"d".repeat(20)}`,
    `ntn_${"e".repeat(46)}`,
    `lin_api_${"f".repeat(40)}`,
    `sbp_${"0".repeat(40)}`,
    `dop_v1_${"1".repeat(64)}`,
    `shpat_${"a".repeat(32)}`,
    `pypi-${"g".repeat(60)}`,
    `123456789:AA${"h".repeat(33)}`,
  ];
  for (const sample of samples) {
    assert.equal(
      redactSecrets(`token ${sample} end`).text,
      "token [REDACTED] end",
    );
  }
  assert.equal(
    redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==").text,
    "Authorization: Basic [REDACTED]",
  );
  assert.equal(
    redactSecrets(
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ).text,
    "AWS_SECRET_ACCESS_KEY=[REDACTED]",
  );
});

test("ordinary text is left alone", () => {
  const text =
    "Basic setup: run npm test, commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f, id 01a0be90-510f-76d0-a598-91855504cf1a, secret_name = x";
  assert.deepEqual(redactSecrets(text), { text, redacted: false });
});

test("PEM key bodies are redacted when sed stripped the BEGIN line", () => {
  // npx convex env list --prod | sed -E 's/=.*//' | sort | tr '\n' ' '
  // with two .p8 keys among the values. The sed turned each first line,
  // NAME=-----BEGIN PRIVATE KEY-----, into NAME and left the rest.
  const first = fakeP8Body("first");
  const second = fakeP8Body("second");
  const sorted = [
    "APPLE_IAP_KEY_ID",
    "APPLE_IAP_PRIVATE_KEY",
    ...first,
    END,
    "APPLE_SIGN_IN_KEY_ID",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    ...second,
    END,
    "SITE_URL",
  ].sort();
  const leaked = `${sorted.join(" ")} `;
  const keyLines = sorted.filter((word) => word.length === 64);
  assert.equal(keyLines.length, 6);

  const { text, redacted } = redactSecrets(leaked);
  assert.equal(redacted, true);
  for (const line of keyLines) {
    assert.equal(text.includes(line), false, line);
  }
  // Only the key lines go. Names, END lines and the 8-character last lines
  // stay: for a P-256 key those hold the end of the public key, and a word
  // that short can't be told apart from ordinary text.
  const kept = sorted.filter((word) => !keyLines.includes(word));
  assert.deepEqual(
    text.replaceAll(KEY, " ").split(" ").filter(Boolean),
    kept.join(" ").split(" "),
  );
  for (const name of ["APPLE_IAP_KEY_ID", "APPLE_SIGN_IN_KEY_ID", "SITE_URL"]) {
    assert.equal(text.includes(` ${name} `), true, name);
  }
});

// convex env list prints NAME='value' for multi-line values. The sed turns
// NAME='-----BEGIN PRIVATE KEY----- into NAME. A value without a trailing
// newline ends in -----END PRIVATE KEY-----', and one with a trailing newline
// leaves a line holding just the closing quote.
function quotedEnvList(quote: string): {
  lines: string[];
  keyLines: string[];
} {
  const first = fakeP8Body(`${quote}first`);
  const second = fakeP8Body(`${quote}second`);
  const names = [
    "APPLE_AUTH_TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION",
    "APPLE_IAP_PRIVATE_KEY",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "AUTH_GOOGLE_SECRET",
    "CUSTOM_AUTH_SITE_URL",
    "GEMINI_API_KEY",
    "JWKS",
    "JWT_PRIVATE_KEY",
    "NEW_USER_SIGNUP_NOTIFICATION_TO",
    "RETENTION_PURGE_ENABLED",
    "SITE_URL",
  ];
  // sort ignores case and punctuation here, which puts the END lines and
  // the lone quote first.
  const sorted = [...names, ...first, ...second].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    lines: [END, `${END}${quote}`, quote, ...sorted],
    keyLines: [...first, ...second].filter((line) => line.length === 64),
  };
}

test("quoted env list values are redacted when sed stripped the BEGIN line", () => {
  for (const quote of ["'", '"']) {
    const { lines, keyLines } = quotedEnvList(quote);
    assert.equal(keyLines.length, 6);
    // echo "== prod"; npx convex env list --prod | sed -E 's/=.*//' | sort |
    // tr '\n' ' '
    const spaced = `== prod\n${lines.join(" ")} `;
    assert.equal(
      spaced.startsWith(`== prod\n${END} ${END}${quote} ${quote} `),
      true,
    );
    const text = assertOnlyKeyLinesRemoved(spaced, keyLines);
    for (const name of ["AUTH_GOOGLE_SECRET", "JWT_PRIVATE_KEY", "SITE_URL"]) {
      assert.equal(text.includes(` ${name} `), true, name);
    }

    // The same without tr, one word per line.
    assertOnlyKeyLinesRemoved(`== prod\n${lines.join("\n")}\n`, keyLines);
  }
});

test("BEGIN-less PEM bodies are redacted across newlines and escaped newlines", () => {
  const { text: body, lines } = beginlessPem();
  assert.equal(lines.length >= 3, true);
  assert.equal(redactSecrets(body).text, `${KEY}\n${END}\n`);

  const escaped = JSON.stringify({ stdout: body });
  assert.equal(escaped.includes(lines[0]), true);
  assert.equal(redactSecrets(escaped).text, `{"stdout":"${KEY}\\n${END}\\n"}`);

  // Inside escaped quotes, as in a tool call's JSON arguments.
  const command = JSON.stringify({ command: `printf '%s' "${body}"` });
  assert.equal(command.includes(`\\"${lines[0]}`), true);
  assert.equal(
    redactSecrets(command).text,
    `{"command":"printf '%s' \\"${KEY}\\n${END}\\n\\""}`,
  );

  // Sorted onto separate lines, with names in between.
  const sorted = [...lines, END, "APPLE_IAP_KEY_ID", "SITE_URL"]
    .sort()
    .join("\n");
  const redacted = redactSecrets(sorted).text;
  for (const line of lines) {
    assert.equal(redacted.includes(line), false, line);
  }
  assert.match(redacted, /^APPLE_IAP_KEY_ID$/m);
  assert.match(redacted, /^SITE_URL$/m);
});

test("long base64 without a PRIVATE KEY marker is left alone", () => {
  // Hash output, not a key: it doesn't start with a private key's DER header.
  const line = createHash("sha512")
    .update("ordinary")
    .digest("base64")
    .slice(0, 64);
  const untouched = [
    `${line}\n${line}\n${line}`,
    `integrity sha512-${line} for ${line}`,
    `${line}\n${line}\n-----END PUBLIC KEY-----`,
    `${line}\n${line}\n-----END CERTIFICATE-----`,
    'const footer = "-----END PRIVATE KEY-----";',
    `'${line}' "${line}" '-----END PUBLIC KEY-----'`,
    `KEY='${line}' # see '${END}'`,
    `${END}\nAPPLE_IAP_KEY_ID SITE_URL CONVEXDEPLOYMENTNAME`,
  ];
  for (const text of untouched) {
    assert.equal(redactSecrets(text).text, text, text);
  }
});

test("the BEGIN-less PEM rule stays linear on long runs", () => {
  const word = "abcdefghijklmnopqrstuvwxyz0123456789";
  const samples = [
    `${word} `.repeat(20_000),
    `${word}\\n`.repeat(20_000),
    `'${word}' `.repeat(20_000),
    `${word}\\"`.repeat(20_000),
    "-----END ".repeat(20_000),
    `${END} ${"ab ".repeat(100_000)}`,
  ];
  for (const sample of samples) {
    const ms = redactionCpuMs(sample);
    assert.ok(ms < 10_000, `took ${ms} ms of CPU`);
  }
});

// A throwaway key's PEM lines, the base64 between BEGIN and END.
function pemBodyLines(
  privateKey: KeyObject,
  type: "pkcs1" | "pkcs8",
): string[] {
  const der = privateKey.export({ type, format: "der" });
  return der.toString("base64").match(/.{1,64}/g) ?? [];
}

test("private keys are redacted by their DER header when both PEM lines were mangled", () => {
  // What a truncating env listing put in the archive on 8 Oct 2026: the
  // BEGIN line cut short and "..." in front of the END line.
  const lines = beginlessPem().lines;
  const listing = [
    "AUTH_GOOGLE_ID=1234...",
    "GOOGLE_PRIVATE_KEY='-----BE...",
    ...lines.slice(0, -1),
    `${lines.at(-1)}...`,
    "-----END PRIVATE KEY-----'",
    "GOOGLE_SHEET_ID=154_n53m...",
  ].join("\n");
  const text = redactSecrets(listing).text;
  for (const line of lines) {
    assert.equal(text.includes(line), false, line);
  }
  assert.equal(
    text,
    `AUTH_GOOGLE_ID=1234...\nGOOGLE_PRIVATE_KEY='-----BE...\n${KEY}...\n-----END PRIVATE KEY-----'\nGOOGLE_SHEET_ID=154_n53m...`,
  );
});

test("private keys are redacted by their DER header in every shape", () => {
  const keys = [
    pemBodyLines(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
      "pkcs1",
    ),
    pemBodyLines(
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
      "pkcs8",
    ),
    pemBodyLines(
      generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey,
      "pkcs8",
    ),
    pemBodyLines(generateKeyPairSync("ed25519").privateKey, "pkcs8"),
    pemBodyLines(generateKeyPairSync("x25519").privateKey, "pkcs8"),
    [
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      createHash("sha512").update("openssh").digest("base64").slice(0, 70),
    ],
  ];
  for (const lines of keys) {
    const shapes = [
      // Bare, cut off before the END line.
      `${lines.join("\n")}\n(output truncated)`,
      // JSON-escaped, once and twice.
      JSON.stringify({ out: lines.join("\n") }),
      JSON.stringify(JSON.stringify({ out: lines.join("\n") })),
      // A file read with line numbers, the END line not reached.
      lines
        .map((line, i) => `${String(i + 40).padStart(6)}\t${line}`)
        .join("\n"),
      // Lines added in a diff, as quoted array items.
      lines.map((line) => `+  "${line}",`).join("\n"),
    ];
    for (const shape of shapes) {
      const text = redactSecrets(shape).text;
      for (const line of lines) {
        assert.equal(text.includes(line), false, `${line} in ${text}`);
      }
      assert.equal(text.includes(KEY), true);
    }
  }
});

test("text that only names a DER header is left alone", () => {
  const untouched = [
    "Apple .p8 keys start with MIGTAgEAMBMGByqGSM49AgEG, RSA ones MIIEvQ.",
    "const P256 = /MIGTAgEAMBMGByqGSM49AgEG/;",
    "rg -l 'MIIEvQIBADANBgkqhkiG9w0BAQEF' ~/dev",
  ];
  for (const text of untouched) {
    assert.equal(redactSecrets(text).text, text, text);
  }
});

test("the DER header rule stays linear on long runs", () => {
  const line = `MIIEvQIBADANBgkqhkiG9w0BAQEF${"a".repeat(36)}`;
  const samples = [
    `${line}\n`.repeat(20_000),
    `${line}${" 1\t".repeat(50_000)}`,
    `${line}${' "," '.repeat(50_000)}x`,
    `${line}\n${"+".repeat(100_000)}`,
  ];
  for (const sample of samples) {
    const ms = redactionCpuMs(sample);
    assert.ok(ms < 10_000, `took ${ms} ms of CPU`);
  }
});

test("Threadbear's own tokens are redacted", () => {
  const token = "tb_" + "ab12".repeat(16);
  const { text, redacted } = redactSecrets(`phone token ${token} saved`);
  assert.equal(redacted, true);
  assert.equal(text.includes(token), false);
  assert.equal(redactSecrets("tb_short is a name").redacted, false);
  const runnerKey = "tbr_" + "ab12".repeat(16);
  assert.equal(redactSecrets(`runner key ${runnerKey} saved`).text.includes(runnerKey), false);
  assert.equal(redactSecrets("tbr_short is a name").redacted, false);
});

test("scrubbing twice changes nothing more", () => {
  const once = scrubText(`OPENAI_API_KEY=sk-${"a1".repeat(24)} and Bearer ${"b2".repeat(20)}`);
  assert.equal(scrubText(once), once);
});

test("scrubDoc scrubs free text at any depth and leaves identity fields", () => {
  const secret = `sk-${"a1".repeat(24)}`;
  const doc = {
    key: secret,
    threadId: secret,
    title: `see ${secret}`,
    createdAt: secret,
    asks: [{ action: `use ${secret}`, options: [secret, "plain words here"] }],
    count: 3,
    none: null,
  };
  const out = scrubDoc(doc);
  assert.equal(out.key, secret);
  assert.equal(out.threadId, secret);
  assert.equal(out.createdAt, secret);
  assert.equal(JSON.stringify([out.title, out.asks]).includes(secret), false);
  assert.equal(out.asks[0]!.options[1], "plain words here");
  assert.equal(out.count, 3);
  assert.equal(out.none, null);
  assert.equal(doc.title, `see ${secret}`, "the original isn't touched");
});

test("scrubDoc hands back the same object when nothing changed", () => {
  const doc = { title: "an ordinary title", asks: [{ action: "merge it please" }] };
  assert.equal(scrubDoc(doc), doc);
});

test("a check that throws holds the text back and says so", () => {
  const failures: unknown[] = [];
  const out = scrubDoc(
    { title: "something to check", note: "short" },
    () => {
      throw new Error("boom");
    },
    (e) => failures.push(e),
  );
  assert.equal(out.title, HELD_BACK);
  assert.equal(out.note, "short");
  assert.equal(failures.length, 1);
});

test("the rules have a version", () => {
  assert.equal(typeof SCRUB_RULES_VERSION, "number");
});

test("the backend's copy of the rules is the runner's", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  assert.equal(read("../../../convex/redaction.ts"), read("../../src/redaction.ts"), "convex/redaction.ts and runner/src/redaction.ts must be byte-identical: copy one over the other");
});

test("a key the runner's own cut left short is caught at the very end of the text", () => {
  const google = `AIza${"aB3".repeat(12)}aB3`;
  const cut = (head: string, value: string, keep: number) => `${head} ${value.slice(0, keep)}`;
  for (const text of [
    cut("please look at this one", google, 38),
    `${cut("in a preview", google, 30)}…`,
    cut("look", `ghp_${"a1".repeat(18)}`, 16),
    cut("look", `AKIA${"ABCD2345".repeat(2)}`, 15),
    cut("token", `eyJ${"a".repeat(30)}.eyJ${"b".repeat(40)}`, 28),
    `Authorization: Bearer ${"c3".repeat(6)}`,
  ]) {
    const { text: out, redacted } = redactSecrets(text);
    assert.equal(redacted, true, text);
    assert.match(out, /\[REDACTED\]…?$/, text);
  }
  for (const text of ["install sk-learn", "pk-short", "use npm_config_registry", "see AIza here", "eyJ is how they start", "the key ghp_ is a prefix", "tb_land", "Fix hf_transfer", "use hf_transformers", "check npm_registry", "a secret_santa"]) {
    assert.equal(redactSecrets(text).redacted, false, text);
  }
});

test("the keychain rule stays linear on a long line", () => {
  const text = "security add-generic-password ".repeat(80_000);
  const ms = redactionCpuMs(text);
  assert.ok(ms < 10_000, `took ${ms} ms of CPU`);
  const secret = `h${"unter2".repeat(3)}`;
  assert.equal(scrubText(`security add-generic-password -a me -s x -w ${secret}`).includes(secret), false);
});

test("repeated unclosed PEM lines stay linear", () => {
  const sizes = [20_000, 80_000];
  const times = sizes.map((n) => {
    const text = "-----BEGIN PRIVATE KEY-----\n".repeat(n);
    return redactionCpuMs(text);
  });
  // A 2.2 MB text: quadratic took minutes before.
  assert.ok(times[1]! < 10_000, `${times[1]} ms`);
});

test("a whole PEM block still goes, labels matched, and a mismatched END doesn't take it", () => {
  const body = "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg".padEnd(64, "x");
  assert.equal(scrubText(`a -----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY----- b`), "a [REDACTED PRIVATE KEY] b");
  assert.equal(scrubText(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nthen -----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`), "[REDACTED PRIVATE KEY]\nthen [REDACTED PRIVATE KEY]");
});

test("a command's answers: keys are the question's words, and no key name is special", () => {
  const secret = `sk-${"a1".repeat(24)}`;
  const doc = { state: "done", answers: { [`Use ${secret}?`]: "yes please", key: secret, createdAt: secret, plain: "fine answer" } };
  const out = scrubDoc(doc);
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.equal(out.answers.plain, "fine answer");
  assert.equal(Object.keys(out.answers).length, 4);
  const same = { answers: { "ordinary question?": "yes" } };
  assert.equal(scrubDoc(same), same);
});

test("machine words are left alone whatever a known value is", () => {
  const scrub = (t: string) => t.replaceAll("question", "[REDACTED]");
  const out = scrubDoc({ kind: "question", status: "question", role: "question", title: "a question here" }, scrub);
  assert.equal(out.kind, "question");
  assert.equal(out.status, "question");
  assert.equal(out.role, "question");
  assert.equal(out.title, "a [REDACTED] here");
});

test("more cut-short keys: Notion, Telegram, ours, and one with a cut mark after it", () => {
  for (const text of [`see secret_${"aB3".repeat(5)}`, `see ntn_${"aB3".repeat(5)}`, `aa_${"ab12".repeat(4)}_${"xY".repeat(6)}`, `bot 123456789:AA${"bC1".repeat(5)}`]) {
    assert.ok(scrubText(text).endsWith("[REDACTED]"), text);
  }
  const marked = `key AIza${"aB3".repeat(6)}\n\n[cut: the rest is on the Mac]`;
  assert.equal(scrubText(marked).includes("aB3"), false);
  assert.ok(scrubText(marked).endsWith("[REDACTED]\n\n[cut: the rest is on the Mac]"));
});

test("a block with many unclosed labels in front of it still goes", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `-----BEGIN L${i} PRIVATE KEY-----`).join("\n");
  const line = "Zm9v".repeat(16);
  const out = scrubText(`${labels}\n-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n1: ${line}\n2: ${line}\n-----END RSA PRIVATE KEY-----`);
  assert.equal(out.includes(line), false);
});

test("no rule is slow on a long run of what it's looking for", () => {
  for (const unit of ["prod:a:", "eyJabcdefgh-", "-----BEGIN PRIVATE KEY-----\n", "security add-generic-password ", "eyJabcdefgh.eyJ"]) {
    // Seconds at worst on a loaded Mac, against many minutes when quadratic.
    const text = unit.repeat(80_000);
    assert.ok(redactionCpuMs(text) < 30_000, unit);
    const end = `${text}!`;
    assert.ok(redactionCpuMs(end) < 30_000, unit);
  }
});

test("folders aren't changed, as they're looked up", () => {
  const doc = { cwd: "/Users/x/dev/sk-abcdefgh1", folders: ["/Users/x/dev/hf_trans1er9"], title: "a title goes here" };
  assert.equal(scrubDoc(doc), doc);
});

test("a free-text model name doesn't get a pass", () => {
  const secret = `sk-${"a1".repeat(24)}`;
  assert.ok(!JSON.stringify(scrubDoc({ model: secret, icon: secret })).includes(secret));
});

test("a long cut-short key with no digit in it", () => {
  const text = `${"x".repeat(13)} secret_${"aB".repeat(20)}`.slice(0, 60);
  assert.ok(scrubText(text).endsWith("[REDACTED]"));
  assert.equal(scrubText("see secret_santaparty"), "see secret_santaparty");
});
