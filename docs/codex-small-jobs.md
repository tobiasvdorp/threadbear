# Codex small jobs

Titles, librarian looks, and other runner model calls enter `Models`.
It owns privacy, concurrency, login choice, failover, and usage records.
Provider executors own only a single CLI invocation and response parsing.

The two designs considered were a separate Codex service for each feature,
and provider dispatch in the existing Models service. The shared service
keeps callers independent of the provider and gives both providers the same
privacy and failover behavior. Separate services would duplicate those rules.

The caller stays unchanged: `models.generate({ feature, prompt, cwd })`.
`ModelSettings` adds optional provider, model, and effort fields. Existing
configurations keep Claude job routes at low effort. Codex uses Luna when
no model is supplied. Explicit model settings override every job route,
including strong requests. A call snapshots its settings before awaiting.

`askCodex(CodexRequest): Promise<CliResponse>` and `askCli(CliRequest)`
share process lifetime handling through `executeCli`. Codex resolves the
managed binary for each invocation and uses an ephemeral, read-only exec.
Its JSONL parser requires both a completed turn and a final agent message.
Provider failures stay in the existing ModelResult failure contract.

The codexSmallJobs experiment is off by default. Settings expose the
configured model and effort, and list pools with matching provider logins.
The provider and model are edited through runner.json or settings.update.
