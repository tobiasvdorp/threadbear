// One small-model call on a Claude login (docs/protocol.md, "Settings and
// models"): the official CLI in print mode, stripped down to the model
// alone. Nothing of Mike's setup loads (no tools, MCP servers, settings,
// hooks, CLAUDE.md or skills), so a title costs a few hundred tokens of
// context rather than tens of thousands, and nothing is saved as a session,
// so the Agent Archive never sees these calls as threads. Never throws; the
// caller (models/index.ts) decides whether to try another login or move on.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Account, EffortLevel } from '../protocol.ts';
import { cliEnv } from '../adapters/claude/adapter.ts';
import { USAGE_LIMIT_TEXT } from '../adapters/claude/normalize.ts';
import { groupAlive, killGroup } from '../proc.ts';

export type CliRequest = {
  claudePath: string;
  account: Account;
  model: string;
  effort?: EffortLevel;
  system?: string;
  user: string;
  // Structured output through --json-schema (classify and extract).
  jsonSchema?: Record<string, unknown>;
  // An empty folder for the CLI to run in.
  cwd: string;
  timeoutMs: number;
  // The runner's process registry, so a CLI never outlives the runner.
  registry?: { add(pid: number, command: string): void; remove(pid: number): void };
};

export type CliResponse =
  | { ok: true; text: string; inputTokens?: number; outputTokens?: number; notionalUsd?: number }
  // limit: the login said it's out of room, so another one may answer.
  | { ok: false; timedOut: boolean; limit: boolean; message: string };

export type AskCli = (req: CliRequest) => Promise<CliResponse>;

// Without a system prompt of its own the CLI would use Claude Code's, which
// is long and all about being a coding agent.
const DEFAULT_SYSTEM = 'Answer the message. Plain text, no preamble.';

export function cliArgs(req: Pick<CliRequest, 'model' | 'system' | 'jsonSchema' | 'effort'>): string[] {
  const args = [
    '-p',
    '--model',
    req.model,
    // Each of these keeps something of Mike's setup out. --bare would do it
    // in one, but it also skips the keychain, and the login lives there.
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    // Haiku thinks less at low effort: a title is 15 output tokens, not 135.
    '--effort',
    req.effort ?? 'low',
    '--output-format',
    'json',
    '--system-prompt',
    req.system?.trim() || DEFAULT_SYSTEM,
  ];
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  return args;
}

export const askCli: AskCli = (req) => executeCli(req, {
  command: req.claudePath, args: cliArgs(req), env: cliEnv(req.account), prompt: req.user, read: readReply,
});

export function executeCli(req: Pick<CliRequest, 'cwd' | 'timeoutMs' | 'registry'>, run: {
  command: string; args: string[]; env: NodeJS.ProcessEnv; prompt: string;
  read: (out: string, err: string, code: number | null) => CliResponse;
}): Promise<CliResponse> {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(req.cwd, { recursive: true });
    } catch {
      // spawn says so below
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(run.command, run.args, {
        cwd: req.cwd,
        env: run.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, like a thread's CLI, so a timeout stops
        // anything it started too.
        detached: true,
      });
    } catch (e) {
      resolve({ ok: false, timedOut: false, limit: false, message: `Couldn't start model CLI: ${(e as Error).message}` });
      return;
    }
    const pid = child.pid;
    if (pid) req.registry?.add(pid, run.command);
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out = (out + d).slice(-2_000_000)));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (!pid) return;
      killGroup(pid, 'SIGTERM');
      setTimeout(() => {
        if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
      }, 3000).unref();
    }, req.timeoutMs);
    timer.unref?.();
    const finish = (r: CliResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pid) req.registry?.remove(pid);
      resolve(r);
    };
    child.on('error', (e) => finish({ ok: false, timedOut: false, limit: false, message: `Couldn't start model CLI: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, timedOut: true, limit: false, message: `Timed out after ${Math.round(req.timeoutMs / 1000)} s` });
      finish(run.read(out, err, code));
    });
    // The prompt goes in on stdin rather than as an argument: thread text
    // can be long, and it keeps it out of `ps`.
    child.stdin?.on('error', () => {});
    child.stdin?.end(run.prompt);
  });
}

// The CLI's --output-format json answer: one JSON object, the last line of
// stdout.
export function readReply(stdout: string, stderr: string, code: number | null): CliResponse {
  const line = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  let json: CliJson | undefined;
  try {
    json = line ? (JSON.parse(line) as CliJson) : undefined;
  } catch {
    // said below
  }
  if (!json) {
    const why = (stderr.trim() || stdout.trim()).split('\n').pop()?.slice(0, 200);
    return { ok: false, timedOut: false, limit: USAGE_LIMIT_TEXT.test(stderr), message: `claude exited ${code ?? 'on a signal'} with no answer${why ? `: ${why}` : ''}` };
  }
  const result = typeof json.result === 'string' ? json.result : '';
  if (json.is_error || json.subtype !== 'success') {
    const limit = json.api_error_status === 429 || USAGE_LIMIT_TEXT.test(result);
    return { ok: false, timedOut: false, limit, message: `claude: ${result.slice(0, 200) || json.subtype || 'error'}` };
  }
  const text = json.structured_output !== undefined ? JSON.stringify(json.structured_output) : result;
  const u = json.usage;
  const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : undefined;
  return {
    ok: true,
    text,
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(u?.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(typeof json.total_cost_usd === 'number' ? { notionalUsd: json.total_cost_usd } : {}),
  };
}

// The empty folder pool calls run in.
export function cliDir(home: string): string {
  return path.join(home, 'models', 'cli');
}

type CliJson = {
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  api_error_status?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
};
