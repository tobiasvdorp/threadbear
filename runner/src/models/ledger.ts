// models/usage.ndjson: one line per model call that went out, as a record
// of what the runner's small jobs asked and on which login. Never any text
// from the call.
import fs from 'node:fs';
import path from 'node:path';

export type UsageLine = {
  ts: string;
  feature: string;
  job: string;
  model: string;
  effort?: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  // The login it ran on, and what the CLI says it would have cost on the
  // API. Not spent: the login's room pays for it.
  accountId?: string;
  notionalUsd?: number;
  error?: string;
};

export function ledgerPath(home: string): string {
  return path.join(home, 'models', 'usage.ndjson');
}

// Appends each line to the file. Lines from before OpenRouter was dropped
// may have a costUsd; nothing reads it any more.
export class Ledger {
  private file: string;

  constructor(home: string) {
    this.file = ledgerPath(home);
  }

  add(u: UsageLine): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(u) + '\n');
    } catch {
      // The file is a record; a call that couldn't be written down still ran.
    }
  }
}
