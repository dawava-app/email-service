# Email Service Integration Guide (Backend)

## Summary
This document provides:
1. A factual review of the current email service implementation.
2. A ranked decision guide for integration options (current + future), including pros/cons and when to use each.

Scope is based on the current codebase behavior in `src/controllers`, `src/routes`, `src/queue`, `src/services`, `src/config`, and `src/validation`.

## Public APIs / Interfaces
- No API or code changes are introduced by this guide.
- All contracts described below reflect the service behavior as currently implemented.

## Current Integration Surface (As Implemented)

### 1) Direct synchronous send: `POST /email/send`
- Auth: requires `x-service-token` header matching `EMAIL_SERVICE_AUTH_TOKEN`.
- Validation: payload validated against `src/validation/emailSchema.json`.
- Core behavior:
  - Idempotency guard using in-memory TTL map.
  - If `templateId` is set and both `text` and `html` are absent, text is rendered from template store.
  - Sends through Mailjet provider.
- Success response: `202 { "status": "sent" }`
- Failure response: `500 { "status": "failed", "error": "..." }`

Minimal request:
```bash
curl -X POST http://localhost:5060/email/send \
  -H 'content-type: application/json' \
  -H 'x-service-token: change-me-email-service-token' \
  -d '{
    "to": ["user@example.com"],
    "subject": "Welcome",
    "text": "Hello"
  }'
```

### 2) Bulk row templating: `POST /email/bulk-template`
- Auth: same token header.
- Input contract:
  - `headers` array must include `email` (case-insensitive).
  - `rows` array of arrays.
  - `template` required; `subjectTemplate` optional (defaults to `Notification`).
  - `dryRun` optional.
- Placeholder support:
  - `{{1}}` = 1-based column position.
  - `{{headerName}}` = column by header name (case-insensitive).
- `dryRun: true`: returns render preview only.
- `dryRun: false` or omitted: sends one-by-one via Mailjet and returns summary.

Minimal request:
```json
{
  "headers": ["email", "name", "role"],
  "rows": [["alice@example.com", "Alice", "Coordinator"]],
  "template": "Hello {{name}}, role: {{role}}",
  "subjectTemplate": "Welcome {{name}}",
  "dryRun": true
}
```

### 3) Bulk sheet upload: `POST /email/bulk-template-sheet` (multipart)
- Auth: same token header.
- Upload field: `sheet` (CSV/TSV/XLSX, 5 MB file-size limit via multer).
- Additional fields: `template` required, `subjectTemplate` optional, `dryRun` optional.
- Parsing behavior:
  - First non-empty row = headers.
  - Headers must include `email`.
  - Data rows parsed into template rendering flow.

Minimal request:
```bash
curl -X POST http://localhost:5060/email/bulk-template-sheet \
  -H 'x-service-token: change-me-email-service-token' \
  -F 'sheet=@participants.xlsx' \
  -F 'template=Hello {{name}}' \
  -F 'subjectTemplate=Welcome {{name}}' \
  -F 'dryRun=true'
```

### 4) Bulk sheet by remote URL: `POST /email/bulk-template-sheet` (JSON)
- Disabled by default.
- Requires:
  - `ENABLE_REMOTE_SHEET_URL=true`
  - Non-empty `SHEET_URL_ALLOWLIST`
- Security controls in parser:
  - Protocol must be HTTP/HTTPS.
  - Credentials in URL are blocked.
  - Localhost/local/private IP targets are blocked.
  - Host must be allowlisted (exact or subdomain).
  - Redirects are disabled.

Minimal request:
```json
{
  "sheetUrl": "https://docs.example.com/data.csv",
  "template": "Hello {{name}}",
  "subjectTemplate": "Welcome {{name}}",
  "dryRun": true
}
```

### 5) Async event-driven path: Redis Stream consumer
- Consumer starts with the service and reads from configured stream.
- Expected stream entry shape:
  - Field name: `payload`
  - Field value: JSON string matching email schema.
- Processing flow:
  - Validate payload schema.
  - Idempotency check.
  - Optional template rendering fallback.
  - Send via Mailjet.
  - On send failure, requeue with incremented `retries` until `EMAIL_MAX_RETRIES`.

Minimal producer example:
```bash
redis-cli XADD email_events '*' payload '{"schemaVersion":"1.0","to":["user@example.com"],"subject":"Welcome","text":"Hello"}'
```

## Required Auth and Configuration Contracts

### Ingress auth
- `EMAIL_SERVICE_AUTH_TOKEN` must be configured, otherwise `/email/*` returns `503`.
- Caller must send matching `x-service-token`, otherwise `401/403`.

### Mail provider
- `MAILJET_API_KEY`, `MAILJET_API_SECRET`, and `EMAIL_DEFAULT_FROM` are required for production use.

### Redis / consumer
- `REDIS_URL` or (`REDIS_HOST`, `REDIS_PORT`, optional `REDIS_PASSWORD`).
- `REDIS_STREAM_EMAIL` (code fallback `email_events`; `.env.example` currently sets `internal`).
- `EMAIL_MAX_RETRIES` for retry cap.

### Remote sheet URL mode
- `ENABLE_REMOTE_SHEET_URL=true`
- `SHEET_URL_ALLOWLIST` as comma-separated allowed hosts/domains.

## Current-State Review Findings

| ID | Finding | Severity | Impact | Recommended Mitigation |
|---|---|---|---|---|
| F1 | Idempotency store is in-memory per process with 5-minute TTL. | High | Duplicates can pass across restarts/horizontal replicas; no shared dedupe state. | Move idempotency key storage to Redis/DB with explicit TTL and namespace per integration path. |
| F2 | Template store is in-memory and static. | Medium | Template updates require deploy; no runtime template management/version governance. | Externalize templates to DB/config service and enforce explicit version lifecycle. |
| F3 | Stream failures are retried by requeue, but no DLQ/poison queue exists. | High | Permanent failures are lost after max retries; weak post-failure recovery workflow. | Add DLQ stream/queue with reason metadata and replay tooling. |
| F4 | Provider dependency is single-vendor (Mailjet only). | Medium | Outage or account/rate-limit issues can block all email delivery. | Introduce provider abstraction and failover strategy by message class. |
| F5 | REST vs stream have different semantics (sync status vs async eventual processing). | Medium | Integrators may mis-handle delivery guarantees and user-facing behavior. | Publish explicit contract: accepted vs delivered, with per-path SLA and observability guidance. |
| F6 | Remote `sheetUrl` mode has SSRF controls and allowlist gating; still operationally sensitive. | Medium | Misconfigured allowlist can create data-exfiltration risk surface. | Keep disabled by default, require strict domain ownership policy, and monitor fetch attempts/errors. |
| F7 | Schema includes `cc`/`bcc`, but current Mailjet message builder does not map them. | High | Integrators may assume CC/BCC are sent when they are silently ignored. | Either implement mapping in provider layer or clearly mark CC/BCC unsupported until implemented. |
| F8 | Invalid JSON stream entries are warned and skipped without ack/del path in current loop branch. | Medium | Bad entries can remain pending and complicate stream operations. | Handle invalid entries with explicit ack + DLQ or quarantine stream. |
| F9 | Tests require installed dependencies and env setup; fresh checkout without `npm install` fails immediately. | Low | CI/local confusion if setup prerequisites are skipped. | Keep setup prerequisites explicit in README/CI and ensure install step precedes tests. |

## Integration Option Matrix (Ranked Guidance)

### Option A: `POST /email/send` (direct synchronous)
- Recommendation tier: **Primary** for low-volume transactional paths needing immediate API result.
- How to integrate:
  - Backend service calls `/email/send` with schema-compliant payload and `x-service-token`.
- Required payload/config:
  - Required by schema: `to[]`, `subject`.
  - Recommended in production: provide `text`/`html` or a resolvable `templateId` path to avoid provider-side rejection.
  - Required env: auth token + Mailjet credentials + default from address.
- Pros:
  - Simple integration and debugging.
  - Fast path for transactional events.
  - Clear HTTP-level response.
- Cons:
  - Caller is directly exposed to provider/service latency.
  - Harder to absorb spikes without caller-side queuing/retries.
- When to use:
  - Registration confirmations, password reset, short transactional flows.
- When not to use:
  - Burst traffic, campaign-like batch sends, or workflows requiring durable queue semantics.

### Option B: `POST /email/bulk-template` (row JSON)
- Recommendation tier: **Conditional**.
- How to integrate:
  - Caller constructs header + row matrix and template strings; optional dry run first.
- Required payload/config:
  - `headers`, `rows`, `template`; `email` header mandatory.
  - Same service auth + Mailjet env.
- Pros:
  - Good for internal tooling and coordinator-style personalized sends.
  - `dryRun` gives preview before sending.
- Cons:
  - Large request bodies can stress API memory/network.
  - One-by-one send loop can be slow for large sets.
- When to use:
  - Small-to-medium personalized batches generated inside trusted backend/admin tools.
- When not to use:
  - Very large batches or untrusted payload producers.

### Option C: `POST /email/bulk-template-sheet` (file upload)
- Recommendation tier: **Conditional**.
- How to integrate:
  - Multipart upload with `sheet` + template fields; run dry run before actual send.
- Required payload/config:
  - `sheet` file plus `template`.
  - Same auth + Mailjet env.
- Pros:
  - Operator-friendly for CSV/Excel-driven workflows.
  - Avoids custom row JSON building in caller.
- Cons:
  - Upload workflow complexity and file hygiene concerns.
  - Not ideal for fully automated machine-to-machine event flows.
- When to use:
  - Partner/coordinator operations and manual batch operations.
- When not to use:
  - High-frequency automated pipelines.

### Option D: `POST /email/bulk-template-sheet` with `sheetUrl`
- Recommendation tier: **Avoid for now** unless strict governance exists.
- How to integrate:
  - JSON body with `sheetUrl` + template; feature flag and allowlist must be enabled.
- Required payload/config:
  - `ENABLE_REMOTE_SHEET_URL=true`, non-empty `SHEET_URL_ALLOWLIST`.
- Pros:
  - No file upload handling in caller.
  - Easy integration with controlled document hosts.
- Cons:
  - Remote-fetch attack surface and allowlist operations burden.
  - External availability/network adds failure modes.
- When to use:
  - Controlled enterprise domains with tight security policy and auditing.
- When not to use:
  - Public/untrusted hosts or teams without security ownership.

### Option E: Redis Stream producer (`XADD payload`)
- Recommendation tier: **Primary** for resilient async event-driven delivery.
- How to integrate:
  - Producer writes schema-compliant JSON payload to stream field `payload`.
  - Consumer handles validation, retries, and send processing.
- Required payload/config:
  - Schema-compliant JSON payload, recommended `schemaVersion` and idempotency identifiers.
  - Redis connectivity and stream naming alignment.
- Pros:
  - Decouples producer latency from email send latency.
  - Better burst handling and asynchronous resilience.
- Cons:
  - Operational complexity (Redis stream health, pending messages, retries).
  - Current implementation lacks DLQ and has edge-case pending handling gaps.
- When to use:
  - Domain events, workflow emails, and systems prioritizing async resilience.
- When not to use:
  - Immediate caller-visible success/failure requirements.

## Future Options (Provider + Transport)

### Provider strategy options

#### P1) Single provider hardened (Mailjet only)
- Adoption criteria:
  - Budget/time constrained; low provider outage risk tolerance acceptable.
- What to add:
  - Provider-specific observability, stronger retry/DLQ, rate-limit handling, alerting.
- Migration triggers to next strategy:
  - Repeated provider incidents, regional deliverability issues, stricter uptime SLO.

#### P2) Provider abstraction + active/passive failover
- Adoption criteria:
  - Need continuity during provider outage with moderate added complexity.
- What to add:
  - Provider interface, message normalization, fallback routing policy, health-driven failover switch.
- Migration triggers to next strategy:
  - Different workloads requiring distinct providers, cost/performance optimization pressure.

#### P3) Multi-provider routing by use case
- Adoption criteria:
  - Mature platform teams needing policy-based routing (transactional vs bulk vs regional).
- What to add:
  - Policy engine for provider selection, per-provider templates/limits, unified telemetry.
- Tradeoff:
  - Highest complexity and operational overhead.

### Transport strategy options

#### T1) REST-first
- Adoption criteria:
  - Low-to-medium volume, synchronous workflow preference, simpler operations.
- Hardening needed:
  - Caller retries with idempotency keys, backpressure controls, clear timeout strategy.
- Migration trigger:
  - Growing traffic bursts or increasing timeout/retry contention.

#### T2) Redis Streams hardened
- Adoption criteria:
  - Existing Redis footprint and need for async resilience with moderate complexity.
- Hardening needed:
  - DLQ/poison handling, pending-entry recovery, metrics/alerts, replay tooling.
- Migration trigger:
  - Need stronger managed durability/compliance than current Redis operations can provide.

#### T3) Queue-backed managed alternative (e.g., managed message queue)
- Adoption criteria:
  - Higher reliability/compliance requirements and preference for managed queue operations.
- What to add:
  - Producer/consumer adapters, dead-letter strategy, visibility timeout + replay workflow.
- Tradeoff:
  - New infrastructure and migration effort.

## Scenario-Based Recommendations

### 1) User-triggered transactional mail
- Recommended path: **Option A (`/email/send`)**.
- Why: lowest integration overhead and immediate HTTP-level feedback.
- Minimal request:
```json
{
  "to": ["user@example.com"],
  "subject": "Verify account",
  "text": "Your code is 123456"
}
```

### 2) High-volume campaign-like bulk sends
- Recommended path now: **Option C (sheet upload)** for human-driven operations; **Option E (stream)** for system-driven flows.
- Why: avoids oversized row JSON APIs for very large automated sends.
- Minimal stream payload:
```json
{
  "schemaVersion": "1.0",
  "to": ["user@example.com"],
  "subject": "Campaign update",
  "text": "Hello from campaign pipeline"
}
```

### 3) Resilient async event-driven sends
- Recommended path: **Option E (Redis Stream)**.
- Why: producer/caller decoupling and retry workflow.
- Prerequisites:
  - Redis stream governance, idempotency strategy, and DLQ hardening plan.

### 4) Partner/coordinator uploads
- Recommended path: **Option C (file upload)** with mandatory `dryRun` before send.
- Why: operator-friendly workflow with preview guardrail.
- Guardrails:
  - Enforce template review, batch-size limits, and audit logs in upstream tooling.

## Decision Defaults
- Default for synchronous product flows: **Option A**.
- Default for asynchronous domain events: **Option E**.
- Default for manual bulk operations: **Option C with dry run**.
- Do not enable remote `sheetUrl` mode unless security ownership and allowlist governance are in place.

## Test Plan
- Validate document accuracy against controller/route/config/consumer behavior.
- Cross-check payload and auth requirements against JSON schema and middleware.
- Verify request examples and flags match currently implemented endpoints.
- Perform a sanity pass for internal consistency across findings, matrix, and recommendations.

## Acceptance and Validation Checklist
- Endpoint names and behavior match current routes/controllers.
- Auth requirements align with middleware behavior.
- Payload constraints align with JSON schema and template logic.
- Stream behavior and retry notes align with consumer implementation.
- Config/env references align with `src/config/index.js` and `.env.example`.
