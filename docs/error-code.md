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
| No file uploaded | `400` | `missing_source_file` |
| `window.storage` detected | `422` | `unsupported_storage_pattern` |
| Build/deploy failure | `500` | `deploy_failed` |

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