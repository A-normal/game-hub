> This is a development workflow process record. It is not a customer requirement, product rule, acceptance authority, or source for deriving requirements. Follow the cited active requirement sources.

```yaml
artifact_type: dev-workflow-process-ledger
authority: process-record-only
is_requirement_source: false
project: game-hub
increment_id: chat-ai-config-inheritance
workflow_run_id: 2026-10-28
risk_level: MEDIUM
status: VERIFIED
plan_version: 1
checkpoint_sequence: 4
created_at: 2026-10-28
updated_at: 2026-10-29
evidence_valid_as_of: 2026-10-29
```

Authority: the user explicitly approved global defaults with local overrides, durable AI configuration, and clearer character lists in the current turn, following the preceding design discussion. No background processes. Existing `.env.example`, `docker-compose.yml`, and `docs/operations.md` modifications are unrelated and must be preserved. Automatic repository delivery is allowed only on dev-type branches; current branch is `dev`.

| Requirement | Task | Acceptance | Validation |
| --- | --- | --- | --- |
| REQ-01 global defaults with local exceptions | TASK-01 central preference resolution and scoped settings command | AC-01 global character, group/private policies, event and interjection options, memory/sticker switches and conversation limits; local per-field overrides and restore-inheritance; source-aware display | VAL-01 dispatcher tests for inheritance, explicit false/none, per-field reset, independent scopes and permission checks |
| REQ-02 durable live configuration | TASK-02 reuse SQLite settings/options and integrate all consumers | AC-02 runtime changes affect effective inheritors and invalidate affected pending work; restart retains defaults/overrides; histories and memories remain isolated | VAL-02 real temporary SQLite close/reopen; old settings compatibility; in-flight cancellation and branch regression |
| REQ-03 understandable character list | TASK-03 label display name, stable ID and temporary list selection | AC-03 preserve IDs and bindings; private number selection remains scoped/expiring; group list does not promise private selection behavior | VAL-03 independently authored generic card fixtures and dynamic namespace tests |
| REQ-04 bounded delivery | TASK-04 help/docs and regression | AC-04 no scoped plugin/bus shutdown, autonomous memory, export implementation, production DB writes, deployment or background processes | VAL-04 full foreground tests, syntax and diff review |

Contract: reuse existing `chat_settings` for `default:*` preferences and `chat_options` for local patches; do not seed per-session copies of global values. Existing explicit settings stay local. Existing nonempty character bindings stay local; unbound legacy rows follow the new default. An explicit unload from this version stores a distinct no-character marker, while restore-inheritance removes the override. Histories keep their existing per-conversation/per-character branches. Global model selection continues through the existing default-model feature. Source-code/module environment configuration remains separate from live administrator settings.

UI: existing `设置` becomes the unified entry point, with explicit `全局` or `本群`/`本会话` scope for changes and `跟随全局` to remove local overrides. Legacy commands retain local behavior. Existing AI administrator authority governs this entry point. Runtime counters, receipts, summaries, memories and scheduled delivery targets never inherit across sessions. Existing idle greeting jobs remain explicitly per-session; no global job fan-out is introduced.

Containment: all writes stay inside existing plugin tables, changed settings cancel affected jobs through epoch/abort, and no history is cleared as part of setting changes. No application service starts. Git delivery only to `origin/dev`. Gates 0–4 READY for this increment; implementation authorized by current user confirmation. No additional material choice is needed for the bounded implementation.

TODO (later): versioned global configuration export/import using key references rather than secret values. Scoped AI/bus shutdown and silent memory processing remain separate future increments.

History:
- 2026-10-28: reviewed existing settings, branches, queue, events, interjection, character selection and SQLite APIs. Current user authorized TASK-01–04. No runtime configuration changed.
- 2026-10-29: TASK-01–03 implemented. Unified settings and all reply/observer/event consumers resolve defaults live; explicit no-character is distinct from inheritance. New integration tests cover 10 inheritance scenarios, including a real SQLite close/reopen; these and 14 interjection regressions passed 24/24. Existing focused regression initially passed 71/72; updated the one raw-snapshot assertion to verify effective defaults and absence of an unintended override, as required by the new per-field contract. TASK-04 final documentation and full verification pending. No production DB write or background process.
- 2026-10-29: TASK-01–04 complete. Added budget-fallback invalidation and global-character deletion regressions, bringing the new configuration suite to 12 tests. Full foreground regression passed 260/260; all chat-ai source modules and the new test passed syntax checks; Git whitespace checks passed. Validation log: local ignored `.private/chat-ai-config-tests.log`. Operating instructions and unified help document global defaults, per-field reset, existing-NULL character compatibility, model-budget precedence, and the export TODO. REQ-01–04 / AC-01–04 verified for this source-and-test increment. Real QQ deployment is outside the increment; no service or background process started, production DB modified or live model service called. Commit/push only on dev; final delivery evidence is recorded in the local ignored delivery checkpoint.
- 2026-10-29: final review found a legacy local eventsEnabled flag could defeat a per-event inheritance reset. Normalize that flag into the remaining local event values when editing/restoring an event. Added the corresponding regression (13 configuration tests). Final full foreground regression passed 261/261 and syntax checks passed again. No unresolved required check remains for this increment.
