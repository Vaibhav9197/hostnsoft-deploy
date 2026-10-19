# embarko.json

An optional file in the app's top folder that holds platform settings which
belong with the code. Added 2026-10-17. Today it carries one setting,
`schedules` (see hostnsoft-api's `docs/schedules.md`).

```json
{
  "$schema": "https://embarko.ai/schema/embarko.json",
  "schedules": [
    { "cron": "0 9 * * 1-5", "path": "/tasks/daily-digest", "timezone": "Asia/Kolkata", "name": "daily digest" }
  ]
}
```

Implemented in `embarko-config.js`, called from `POST /apps` in `server.js`.
The JSON Schema is served at `https://embarko.ai/schema/embarko.json`
(website repo, `public/schema/embarko.json`).

## Why a file, not a header

An `X-Schedules` header was built first and dropped before release. The file
works through every upload path with no client changes: the skill's tarball,
a raw curl, the dashboard upload, and the connector's JSON `files[]`, where
it is just one more file. It is versioned with the code, so the next agent
session finds it by reading the project. Agents already know the pattern
(`vercel.json`, `fly.toml`). The deploy service already read one such file
(`Staticfile`).

## When it is read

From the uploaded archive, **before the claim** and before anything is
extracted, so a file that can't be trusted refuses the deploy before any
work, and the claim can validate the schedules and create `CRON_SECRET` in
the same call. The `tar` package lists the archive and reads only this
entry, in-process.

Only the top folder counts (the same folder as `package.json`; a deploy
whose app is nested is refused anyway by the manifest-root check).

## Rules, and the problem each one handles

| Rule | Handles |
| --- | --- |
| **No file, or no `schedules` key, changes nothing.** `"schedules": []` removes all. | A missing file being mistaken for "remove all". When the app has schedules and the upload declares none, the reply warns `schedules_unchanged`, so a file deleted by accident is noticed. |
| **Secrets refuse the deploy** (`secrets_in_embarko_json`, 400): a key named like secret, password, token, API key, private key or credential; a value in a known credential format (Stripe, GitHub, Slack, AWS, OpenAI/Anthropic-style keys, private key blocks, JWTs); or a URL carrying `?token=`, `key=`, `secret=` and the like. | The file is code: committed, shared, shown in diffs. The error says where and points at env vars and `CRON_SECRET`. |
| **Top folder only, exact name.** A nested `embarko.json` (outside `node_modules`, `dist` and similar) warns `embarko_json_not_at_top`; `.embarko`, `.embarko.json`, `embarko.yaml`/`.yml`/`.toml`, `embarko.config.json`, `embarko.jsonc` and other near misses warn `embarko_json_misnamed`. | Folder mistakes (already the most common deploy error for `package.json`) and a near-miss name silently doing nothing. |
| **Unknown keys are ignored with a warning** (`embarko_json_unknown_keys`), never refused. Only keys that are built are documented. | Keeping the contract small and forward-compatible: an app written for a later key still deploys on today's platform. |
| **Not valid JSON, not one object, `schedules` not a list, or over 64 KB** refuse the deploy (`invalid_embarko_json`, 400), with line and column for a parse error. | A file that can't be read can't be trusted to mean what it says. |
| **It is the source of truth.** A schedule paused or changed through the agent API is set back by the next deploy whose file lists it. | Stated in the guide, so nobody is surprised. |
| **Optional, written by the AI.** Most apps never have one. | Keeping Embarko "no config" for people. |

Schedule content (cron, path, timezone, limits) is checked by hostnsoft-api
at claim time, the one place those rules live.

## Warnings in the deploy reply

Every non-fatal problem is one `{code, detail}` in the 202's `warnings`,
with a sentence in `next` and `links.help` (built by `deployWarnings` in
`server.js` and `deploy-response.js`):

| Code | When |
| --- | --- |
| `embarko_json_not_at_top` | Found in a subfolder only |
| `embarko_json_misnamed` | A near-miss name in the top folder |
| `embarko_json_unknown_keys` | Keys other than `$schema` and `schedules` |
| `in_process_timer` | No `schedules` in the file, and the code lists a timer library (`detect-timers.js`) |
| `schedules_unchanged` | No `schedules` in the file, and the app has some (`scheduleCount` from the claim) |
| `schedules_on_static_site` | Schedules declared on a static site, which runs no code |

The skill's `deploy.sh` prints them all after "Live".
