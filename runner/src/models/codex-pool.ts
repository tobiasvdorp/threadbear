// One ephemeral Codex call. Auth stays in the login's CODEX_HOME; user
// configuration, project instructions and executable tools stay out.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { codexEnv, resolveCodexBinary } from '../adapters/codex/appserver.ts';
import { executeCli, type CliRequest, type CliResponse } from './claude-pool.ts';

export type CodexRequest = Omit<CliRequest, 'claudePath'> & { codexPath: string };

export async function askCodex(req: CodexRequest): Promise<CliResponse> {
  let schemaDir: string | undefined;
  try {
    fs.mkdirSync(req.cwd, { recursive: true });
    const binary = resolveCodexBinary(req.codexPath);
    const args = [...binary.args, 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '--model', req.model];
    const config: Record<string, string | number | boolean> = {
      model_reasoning_effort: req.effort ?? 'low',
      project_doc_max_bytes: 0,
      base_instructions: req.system?.trim() || 'Answer the message. Plain text, no preamble.',
      developer_instructions: 'Return only the requested answer. Do not use tools.',
      web_search: 'disabled',
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.apps': false,
      'features.plugins': false,
      'features.remote_plugin': false,
      'features.plugin_discovery_prefetch': false,
      'features.skill_mcp_dependency_install': false,
      'features.browser_use': false,
      'features.computer_use': false,
      'features.multi_agent': false,
      'features.skill_search': false,
      'features.view_image': false,
      'features.image_generation': false,
    };
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    if (req.jsonSchema) {
      schemaDir = fs.mkdtempSync(path.join(req.cwd, 'schema-'));
      const schemaFile = path.join(schemaDir, 'output.json');
      fs.writeFileSync(schemaFile, JSON.stringify(req.jsonSchema), { mode: 0o600 });
      args.push('--output-schema', schemaFile);
    }
    args.push('-');
    return await executeCli(req, { command: binary.command, args,
      env: codexEnv(req.account, undefined, binary.packageRoot), prompt: req.user, read: readCodexReply });
  } catch (error) {
    return { ok: false, timedOut: false, limit: false, message: `Couldn't start Codex: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (schemaDir) {
      try { fs.rmSync(schemaDir, { recursive: true, force: true }); } catch { /* Cleanup must not fail the caller. */ }
    }
  }
}

const eventSchema = z.object({
  type: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export function readCodexReply(stdout: string, stderr: string, code: number | null): CliResponse {
  let text = '';
  let failure: string | undefined;
  let usage: { input_tokens: number; output_tokens: number } | undefined;
  let completed = false;
  for (const line of stdout.split('\n')) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text ?? '';
    if (event.type === 'turn.completed') { completed = true; usage = event.usage; failure = undefined; }
    if (event.type === 'turn.failed') failure = event.error?.message ?? 'Codex turn failed';
    if (event.type === 'error') failure = event.message ?? 'Codex error';
  }
  if (code === 0 && completed && text && !failure) return { ok: true, text,
    ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}) };
  const message = (failure || stderr.trim() || `Codex exited ${code ?? 'on a signal'} without a completed answer`).slice(-300);
  return { ok: false, timedOut: false, limit: /usage.limit|rate.limit|quota|429|out of room/i.test(message), message };
}
