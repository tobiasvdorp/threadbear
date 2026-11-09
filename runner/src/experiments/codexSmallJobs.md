---
id: codexSmallJobs
name: Codex small jobs
title: Codex small jobs: titles and librarian can use a Codex model and effort
added: 2026-11-06
on: false
reminder: 6a7ca905
---

## What it does

Titles, the librarian and other small jobs can use a Codex login. Ask your agent to set `models.provider` to `codex`, `models.pool` to your Codex pool, `models.model` to `gpt-6-luna` and `models.effort` to `max` in runner.json. This uses your Codex subscription and can take longer than low effort.

## Lives in

`runner/src/models/codex-pool.ts`, provider dispatch in `models/index.ts`, shared process handling in `models/claude-pool.ts`; `models.provider`, `models.model` and `models.effort` in runner.json, settings in `runner/src/settings.ts`, and the model display in app `Views/SettingsView.swift` and `Views/LibrarianHome.swift`. The implementation is described in `docs/codex-small-jobs.md`.

## Taking it out

Remove the Codex executor and provider dispatch, restore Claude-only small jobs and settings, remove the model and effort display from the app, and delete `docs/codex-small-jobs.md`. Remove `experiments.codexSmallJobs` and the Codex small-job settings from runner.json. Keep the shared Models service and Claude defaults.
