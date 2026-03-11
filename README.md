# Email Service

Dedicated microservice for sending transactional emails.

## Features
- Service-token protected ingress for all `/email/*` routes
- REST endpoint for immediate send (`POST /email/send`)
- Bulk row templating endpoint (`POST /email/bulk-template`) with dry-run
- Bulk sheet-based templated endpoint (`POST /email/bulk-template-sheet`) via file upload
- Optional remote sheet URL mode behind allowlist flag (`ENABLE_REMOTE_SHEET_URL=true`)
- Redis Stream consumer (`internal`) for async event-driven emails
- JSON Schema validation (AJV)
- Simple template rendering (in-memory; replace with DB later)
- Idempotency guard (in-memory; replace with Redis or DB)
- Retry with requeue + max attempts
- Provider: Mailjet (v3.1)

## Quick Start
```bash
cp .env.example .env
# edit MAILJET_API_KEY, MAILJET_API_SECRET, EMAIL_SERVICE_AUTH_TOKEN
npm install
npm run dev
```
Service runs on `PORT` (default 5060).

## Docker Deployment (Compose)

Container stack includes:
- `email-api`: HTTP API only (`RUN_API=true`, `RUN_CONSUMER=false`)
- `email-consumer`: stream consumer only (`RUN_API=false`, `RUN_CONSUMER=true`)
- `redis`: backing Redis instance with persisted data volume

### 1) Configure environment
```bash
cp .env.example .env
# required for real sends and protected ingress:
# MAILJET_API_KEY, MAILJET_API_SECRET, EMAIL_DEFAULT_FROM, EMAIL_SERVICE_AUTH_TOKEN
```

### 2) Build and start
```bash
docker compose up -d --build
```

### 3) Verify health
```bash
docker compose ps
curl http://localhost:5060/health
```

### 4) View logs
```bash
docker compose logs -f email-api
docker compose logs -f email-consumer
```

### Run a single role only
API only:
```bash
docker compose up -d redis email-api
```

Consumer only:
```bash
docker compose up -d redis email-consumer
```

### Stop and remove containers
```bash
docker compose down
```

To also remove Redis persisted data:
```bash
docker compose down -v
```

## REST Send Example
```bash
curl -X POST http://localhost:5060/email/send \
  -H 'Content-Type: application/json' \
  -H 'x-service-token: change-me-email-service-token' \
  -d '{
    "to": ["user@example.com"],
    "subject": "Welcome",
    "text": "Hello there"
  }'
```

## Bulk Row Templated Send
Facilitates coordinators sending many personalized emails using a simple row-based template.

Endpoint: `POST /email/bulk-template`

Request body:
```json
{
  "headers": ["email", "name", "age", "title"],
  "rows": [
    ["alice@example.com", "Alice", 23, "Coordinator"],
    ["bob@example.com", "Bob", 30, "Mentor"]
  ],
  "template": "Hello {{name}} (age {{3}}), your title is {{title}}. Your email {{1}}.",
  "subjectTemplate": "Welcome {{name}}",
  "dryRun": true
}
```

Rules:
- Headers MUST include `email` (any position); that column determines the recipient address.
- Placeholders: `{{1}}` numeric (1-based index into row), `{{headerName}}` by header (case-insensitive).
- Unknown placeholders become empty string.
- `subjectTemplate` optional; defaults to `Notification`.
- `dryRun: true` returns preview without sending.

Dry-run response example:
```json
{
  "status": "ok",
  "dryRun": true,
  "total": 2,
  "successCount": 2,
  "failureCount": 0,
  "rendered": [
    {"email": "alice@example.com", "subject": "Welcome Alice", "body": "Hello Alice (age 23), your title is Coordinator. Your email alice@example.com."},
    {"email": "bob@example.com", "subject": "Welcome Bob", "body": "Hello Bob (age 30), your title is Mentor. Your email bob@example.com."}
  ],
  "failures": []
}
```

Sending (omit `dryRun` or set `false`) returns summary:
```json
{
  "status": "sent",
  "dryRun": false,
  "total": 2,
  "successCount": 2,
  "failureCount": 0,
  "failures": []
}
```

## Bulk Sheet Templated Send
Allows uploading a spreadsheet (CSV, TSV, XLSX) or referencing a remote sheet URL instead of passing raw rows.
Remote URL mode is disabled by default and must be explicitly enabled with `ENABLE_REMOTE_SHEET_URL=true` and a non-empty `SHEET_URL_ALLOWLIST`.

Endpoint (multipart upload): `POST /email/bulk-template-sheet`

Multipart form fields:
- `sheet`: file (required if no `sheetUrl` provided)
- `template`: string (required)
- `subjectTemplate`: optional string
- `dryRun`: `true|false`

Endpoint (JSON body with URL): `POST /email/bulk-template-sheet`
```json
{
  "sheetUrl": "https://example.com/data.csv",
  "template": "Hello {{name}}",
  "subjectTemplate": "Greetings {{name}}",
  "dryRun": true
}
```

Parsing rules:
- First non-empty row is treated as headers; must include `email` column.
- Subsequent rows become data; shorter rows are padded with empty strings.
- Same placeholder rules as raw bulk endpoint.

Dry-run response includes parsed `headers` and `rendered` previews.

Example curl (file upload):
```bash
curl -X POST http://localhost:5060/email/bulk-template-sheet \
  -H 'x-service-token: change-me-email-service-token' \
  -H 'Content-Type: multipart/form-data' \
  -F 'sheet=@participants.xlsx' \
  -F 'template=Hello {{name}} your role {{role}}' \
  -F 'subjectTemplate=Welcome {{name}}' \
  -F 'dryRun=true'
```

## Stream Event Format
Producer should XADD:
- key: `payload`
- value: JSON string matching schema (`src/validation/emailSchema.json`)

Example payload:
```json
{
  "schemaVersion": "1.0",
  "to": ["user@example.com"],
  "subject": "Registration Confirmed",
  "templateId": "registration_confirmation",
  "templateVersion": "v1",
  "templateVars": {"name": "Alice", "event": "Tech Summit"},
  "createdAt": "2025-11-15T12:00:00.000Z"
}
```

## TODO (Future Enhancements)
- Replace in-memory idempotency & templates with persistent store
- Add metrics endpoint (Prometheus)
- Multi-provider failover (SES/SendGrid)
- Scheduled sends + localization
- Streaming ingestion for bulk templates (avoid large payload bodies)

## Integration Path
1. Deploy email-service separately (container / VM).
2. Use Mailjet keys; remove SendGrid vars from any configs.
3. Add `EMAIL_SERVICE_URL` to main service for direct fallback.
4. Refactor controllers to emit events instead of direct sending.

## License
Internal use only.
