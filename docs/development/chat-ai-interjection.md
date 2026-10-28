> This is a development workflow process record. It is not a customer requirement, product rule, acceptance authority, or source for deriving requirements. Follow the cited active requirement sources.

```yaml
artifact_type: dev-workflow-process-ledger
authority: process-record-only
is_requirement_source: false
project: game-hub
increment_id: chat-ai-interjection-events
workflow_run_id: 2026-10-28
risk_level: MEDIUM
status: VERIFICATION_PENDING
plan_version: 1
checkpoint_sequence: 3
created_at: 2026-10-28
updated_at: 2026-10-28
evidence_valid_as_of: 2026-10-28
```

Authority: the user accepted the preceding discussion of contextual, probabilistic interjection and explicitly requested implementation, event fixes, and generic templates. The user forbids background processes. Existing unrelated edits to `.env.example`, `docker-compose.yml`, and `docs/operations.md` are outside this increment.

| Requirement | Task | Acceptance | Validation |
| --- | --- | --- | --- |
| REQ-01: contextual interjection with keyword probabilities and model silence | TASK-01: group-scoped settings, message-driven opportunity windows, reply engine integration | AC-01: disabled by default; direct mentions/replies bypass random sampling; other messages use one draw per window, cooldown and daily budget; no timer or extra process | VAL-01: deterministic dispatcher/model tests with injected clock and random source |
| REQ-02: preserve conversational and isolation semantics | TASK-02: bounded message metadata and stale-result guards | AC-02: speaker, reply and mention context available; new messages invalidate obsolete interjection; commands, secrets, off policy, other groups and character branches remain isolated | VAL-02: concurrency, recall, cancellation and cross-session regression tests |
| REQ-03: fix and diagnose event responses using generic templates | TASK-03: initialize fresh notice sessions, expose event outcomes and ingress type | AC-03: real-shaped poke notices reach templates after explicit enablement; first notice, deduplication, policy, target, cooldown and delivery failure are distinguishable | VAL-03: shaped notice and foreground WebSocket integration tests |
| REQ-04: reviewable, maintainable delivery | TASK-04: help/docs and validation | AC-04: live namespace help; operating instructions; no private persona, production DB writes, deployment or background process | VAL-04: syntax, full regression, diff review |

Contract: reuse plugin-owned options, queue, receipts, quota and epoch cancellation. Introduce optional bounded message context metadata via additive schema migration. Group interjection supplements `mention`; `all` retains unconditional replies and `off` stops recording/replying. Defaults: interjection disabled, opportunity window 15s, ordinary probability 5%, keyword probability 40%, follow-up probability 60%, speaking cooldown 60s, at most 6 unsolicited turns/hour. Settings are session-scoped and administrator-only. Character card names and explicit `extensions.game_hub.interjection.keywords` may add interests; they cannot override operator limits or enable behavior. One generation can return `[不回复]`. No autonomous idle loop is introduced.

Containment: disable interjection or events through existing administrator command boundary; epoch changes cancel pending work. No destructive schema migration. No live QQ acceptance is claimed by mock tests.

Gates 0–4: READY for this bounded implementation; user implementation authorization: YES (current turn). Material unknowns for the first increment: 0. Human acceptance of conversation quality and actual deployed NapCat ingress remains pending.

History:
- 2026-10-28: inspected current implementation and upstream NapCat event definition; confirmed fresh notice session bug. Implementation authorized. TASK-01–04 pending; no external side effects performed.
- 2026-10-28: TASK-01–03 implemented; TASK-04 help and operating instructions implemented. Original related regression: 68/68 passed; new deterministic and foreground WebSocket tests: 11/11 passed. Full regression and final review pending. No production DB writes, deployment, background process or model-service request performed.
- 2026-10-28: approval review rejected raw account/message identifier egress. Replaced this with local-only identifier association and window-local prompt labels; regression checks confirm metadata identifiers do not enter model requests. No approval remains pending for that rejected payload.
- 2026-10-28: TASK-01–04 complete. Final full regression passed 248/248 (14 new tests), including concurrency during delivery ACK, anonymous context relations, follow-up probability and bounded long-card prompts. Syntax checks passed for all 10 changed/new modules; Git whitespace checks passed. Initial sandbox-only realpath failures were resolved by rerunning foreground tests in the permitted environment; no production files or live model requests were involved. Full log: local ignored `.private/chat-ai-interjection-tests.log`.
- Delivery state: implementation and automated checks complete; actual QQ/NapCat ingress and subjective conversational quality remain human acceptance items (`VERIFICATION_PENDING`). No service started or deployment performed. Repository commit/push follows the user's standing preference; final Git delivery evidence is also recorded in the local ignored delivery checkpoint.

Resume: after deployment, enable `mention` plus interjection in a chosen test group, enable a poke template in that conversation, and inspect event/interjection status against actual messages. New source code must be loaded by the operator's deployment process; this increment does not hot-reload an already running service. Until live acceptance, do not label simulated WebSocket evidence as QQ delivery proof.
