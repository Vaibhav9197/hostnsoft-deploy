# Requirement: standardize `code` field on all deploy API error responses

## Problem

The deploy API (`POST /apps` and related endpoints on the deploy service
— repo may be named `platform-api` or `deploy-service` depending on
whether the rename migration has run; check which exists) returns
inconsistent error shapes today. Only one error case includes a stable,
machine-readable `code` field; every other error just has a human-
readable `error` string. This makes it hard for an agent to branch on
error type programmatically — it has to pattern-match on wording, which
can change without warning.

**Do not assume a `code` field already exists anywhere except the one
case explicitly confirmed below** — an earlier internal tracking doc
incorrectly claimed the storage-rejection error already had one. Verify
against the actual current code before making any change, not against
that claim.

## Current confirmed behavior (verify against real `server.js` before changing)

| Case | Status | Current response shape |
|---|---|---|
| Wrong/missing token | `401` | `{ "error": "Unauthorized" }` |
| Invalid/missing `X-App-Name` | `400` | `{ "error": "Invalid or missing X-App-Name header. Use lowercase letters and dashes." }` |
| Invalid `X-App-Version` | `400` | `{ "error": "Invalid X-App-Version header. Use letters, numbers, dots, dashes, underscores only." }` |
| Invalid `X-App-Type` (over 60 chars, or non-printable/non-ASCII) | `400` | `{ "error": "Invalid X-App-Type header. Use a short plain-text label of at most 60 characters, e.g. \"portfolio\" or \"task management\"." }` |
| Invalid `X-Agent-Name` (over 60 chars, or non-printable/non-ASCII) | `400` | `{ "error": "Invalid X-Agent-Name header. Use a short plain-text name of at most 60 characters, e.g. \"claude-code\" or \"chatgpt\"." }` |
| No file uploaded | `400` | `{ "error": "No source code uploaded" }` |
| `window.storage` detected | `422` | `{ "error": "Unsupported storage pattern detected", "detail": "...", "filesDetected": [...], "docs": "..." }` — **no `code` field today, despite what any internal doc may claim** |
| Build/deploy failure | `500` | `{ "error": "Deployment failed", "details": "<error.message>" }` |

## Target behavior

Add a `code` field to **every** error response above, without removing
or renaming any existing field (backward compatible — existing callers
reading `error`/`detail`/`details` keep working unchanged).

| Case | HTTP status | `code` value |
|---|---|---|
| Wrong/missing token | `401` | `unauthorized` |
| Invalid/missing `X-App-Name` | `400` | `invalid_app_name` |
| Invalid `X-App-Version` | `400` | `invalid_app_version` |
| Invalid `X-App-Type` | `400` | `invalid_app_type` |
| Invalid `X-Agent-Name` | `400` | `invalid_agent_name` |
| No file uploaded | `400` | `missing_source_file` |
| `window.storage` detected | `422` | `unsupported_storage_pattern` |
| `embarko.json` is not valid JSON, not one object, `schedules` not a list, or over 64 KB | `400` | `invalid_embarko_json` — added 2026-10-17, see `docs/embarko-json.md`; refused before the claim |
| `embarko.json` holds something that looks like a secret | `400` | `secrets_in_embarko_json` — refused before the claim; the message names where |
| A schedule in `embarko.json` breaks a rule (cron, interval, timezone, path, duplicate path, more than 5) | `400` | relayed from hostnsoft-api's claim: `invalid_cron`, `schedule_too_frequent`, `invalid_timezone`, `invalid_path`, `duplicate_schedule_path`, `schedule_limit_reached` |
| A server-side timer library in the dependencies (node-cron, APScheduler…) and no `schedules` in embarko.json | `202` (warning only) | `in_process_timer` in `warnings[]` — see `detect-timers.js`; the deploy goes ahead, the reply quotes timings found in the code and points at schedules |
| embarko.json in a subfolder / misnamed / unknown keys; app has schedules but the upload declares none; schedules on a static site | `202` (warning only) | `embarko_json_not_at_top`, `embarko_json_misnamed`, `embarko_json_unknown_keys`, `schedules_unchanged`, `schedules_on_static_site` in `warnings[]` |
| Build/deploy failure | `500` | `deploy_failed` |
| A static site is redeployed as a server app (the reverse is allowed) | `422` | `app_kind_changed` — added 2026-09-22 with the static fast path, see `Static-apps-req.md`; response also carries `previousKind`/`uploadedKind` |
| A static site's publish fails (router file or copy error) | `500` | `publish_failed` — added 2026-09-29 with the capped wait on static publishes; `status: "failed"`, `success: false` |
| Feedback with an unknown `type` | `400` | `invalid_feedback_type` — added 2026-09-29; the error lists the valid types |
| `/capabilities` or `/capabilities/<topic>` | `301` | Redirects to the agent guide at embarko.ai/docs (since 2026-10-14). The guide answers an unknown topic with `404 unknown_topic` |
| Status/logs for an app the caller can't see | `404` | `not_found` — added 2026-09-29 (these used to carry no `code`) |
| Status/logs when hostnsoft-api can't be reached | `502` | `lookup_failed` — added 2026-09-29 |

Example — the storage-rejection response becomes:

```json
{
  "error": "Unsupported storage pattern detected",
  "code": "unsupported_storage_pattern",
  "detail": "This app calls window.storage, an API specific to Claude Artifacts' sandbox...",
  "filesDetected": ["src/app.jsx"],
  "docs": "https://hostnsoft.com/docs#storage-requirements"
}
```

Only `code` is new; everything else is unchanged.

## Scope

- Only touch the deploy service's `POST /apps` error paths listed above.
- Do not touch success responses — they don't need a `code` field.
- Do not invent additional error cases beyond what's listed — if you find
  another error path in the real code not listed here (e.g. a rate limit
  or a 403), add a `code` for it using the same `snake_case` convention,
  but don't restructure anything not directly related to this change.
- If the `api-service`/`hostnsoft-api` repo also returns public-facing
  error responses (e.g. for dashboard-driven actions), the same
  standardization applies there too — check what error responses
  actually exist in that codebase before assuming this list is complete
  for that service.

## After implementing

Update `docs.md` (wherever it's published — check `hostnsoft.com/docs`)
to remove any note saying `code` fields are inconsistent/only-partially-
implemented, since this work resolves that gap. Don't leave stale
"known limitation" language in published docs once the limitation is
fixed.