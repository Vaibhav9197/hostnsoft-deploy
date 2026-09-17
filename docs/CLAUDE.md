# hostnsoft-deploy

The deploy platform: accepts an app's source as a `.tar.gz`, builds it
with Railpack, and deploys it as a Nomad job behind Traefik. Already
running in production on the hostnsoft server. This repo is the source of
truth for that running service — changes here should be deployed to the
server deliberately. **Note:** the server-side directory is currently
`/home/ubuntu/platform-api/` (its original name, predating this repo
being renamed `hostnsoft-deploy`) — confirm whether it's since been
renamed to match before assuming the commands below are still accurate:
```bash
# copy changed files to the server, then:
pm2 restart platform-api   # or whatever the process is actually named now — check `pm2 list`
```

**Read `../docs/` before making changes here** — particularly
`../docs/session-log-storage-and-security.md`, which documents recent
changes to this exact codebase (the `window.storage` rejection logic, the
app registry) and *why* certain approaches were tried and abandoned (a
storage compatibility shim — don't re-propose it without reading that
history first).

## Key files

- **`server.js`** — the deploy API itself (`POST /apps`, `GET /apps`).
  Currently the single entry point for everything: upload validation,
  Railpack build, Nomad job generation, deployment. **Auth changed
  2026-08-26**: the single shared `PLATFORM_TOKEN` is gone. A deploy now
  sends a company-scoped token via `Authorization: Bearer <token>`, and
  `server.js` confirms it's live by calling `hostnsoft-api`'s
  `POST /internal/deploy-tokens/validate` (see `validate-deploy-token.js`)
  before doing anything else. No `X-Company-Id` for that path — the token
  is company-scoped at creation, so `hostnsoft-api` reads the company off
  the token itself. (`X-Company-Id` is back as of 2026-09-17, but only for
  the `proxy_auth_token` alternative below, which isn't company-scoped.)
  Requires
  `HOSTNSOFT_API_URL` in the environment (fails fast at startup if unset,
  same pattern `PLATFORM_TOKEN` used to follow). **Since 2026-08-27**,
  loaded from a `.env` file next to `server.js` (via `dotenv`, path
  resolved from `__dirname` rather than the process's cwd, since pm2
  doesn't guarantee it launches with cwd set to this directory) — copy
  `.env.example` to `.env` on the server and fill it in, rather than
  relying on the shell/pm2 environment carrying it. `.env` is gitignored;
  never commit it.
- **`validate-deploy-token.js`** — the new company-scoped auth check
  described above. Fails closed (rejects the deploy) if `hostnsoft-api`
  is unreachable or returns anything other than `{valid: true}` —
  logged distinctly from a plain bad-token rejection so ops can tell
  "hostnsoft-api is down" apart from "wrong token" in `pm2 logs`.
- **`record-deployment.js`** (added 2026-08-27) — reports each deploy
  attempt's outcome (success or failure, with the failure's `error.message`
  as the log) to `hostnsoft-api`'s `POST /internal/deployments/record`,
  called from both the success and failure paths in `server.js`. This is
  what makes the dashboard's deployment history real instead of always
  empty. Best-effort and fails open on the *deploy's* own response — a
  `hostnsoft-api` outage here only means this one deploy's outcome doesn't
  get recorded (logged to `pm2 logs`), it never changes the response
  already going back to whoever triggered the deploy.
- **`deploy-credential.js`** (added 2026-09-17) — reads whichever
  credential `POST /apps` presented and packages it for the two
  `hostnsoft-api` calls a deploy makes. **This is where the deploy
  endpoint gained a second accepted credential**: as well as a deploy
  token, it now takes the dashboard's own `proxy_auth_token` plus
  `X-Company-Id`, so the dashboard's upload button can deploy as the
  logged-in person instead of making them mint a company-wide deploy token
  first. Same move already made for `GET /apps/:appName/status`/`.../logs`
  on 2026-09-13 (`verify-proxy-auth.js`), applied to the deploy path
  itself — the SAME endpoint, not a parallel one.
  - A deploy token still **wins** when both are somehow presented, so no
    existing agent/CI caller's behavior can shift.
  - A PAT isn't verified in this process at all: `claim-project.js`'s call
    is the single verification point (`hostnsoft-api` checks the PAT and
    its membership of `X-Company-Id`), which keeps it to one proxy
    round-trip per deploy and makes it impossible for the two services to
    reach different conclusions about the same request. That call already
    ran before any build resource was spent, so a rejected PAT still costs
    nothing.
  - `hostnsoft-api` requires `X-Internal-Secret` on the PAT branch only —
    a PAT is the credential that drives the whole dashboard, far more
    powerful than a company-scoped deploy token, so relaying one proves it
    came from this service. The deploy-token and anonymous branches send
    no such header and are byte-for-byte unchanged.
  - **The anonymous/orphan path is untouched.** Only a request with NO
    credential at all deploys anonymously; a PAT that's present and fails
    is a 401/403, never a silent downgrade — otherwise someone gets a
    self-deleting app they believe is permanent. Nothing about the orphan
    banner needed changing either: the `orphan-proxy` sidecar is keyed off
    `claim.isOrphan`, and a PAT deploy claims under a real company, so it
    comes back false on its own.
  - **CORS** (`cors()` in `server.js`, new `FRONTEND_ORIGIN` env var) —
    the dashboard is this service's first *browser* caller, so without it
    the preflight fails before the upload ever reaches auth. Non-browser
    callers send no `Origin` and are unaffected.
- **`detect-storage-usage.js`** — detects `window.storage` usage
  (Claude Artifacts' sandbox API, which doesn't exist outside it) in an
  app's source before building, and causes `server.js` to reject the
  deploy with a 422 rather than shipping something that will fail at
  runtime. Skips the scan entirely if the app already declares a real DB
  dependency (`better-sqlite3`, `sqlite3`). PGlite is no longer supported.
- **`app-registry.js`** — a **stopgap** flat-JSON-file record of what
  each app last deployed with (`version`, `dbType`, `memory`,
  `deployedAt`). This exists only because this service has no real
  database. `hostnsoft-api` will very likely replace this with proper
  `Project`/`Deployment` tables — treat this file as something to be
  superseded, not a pattern to extend further.

## Known constraints and open gaps (relevant to any change here)

From the current Nomad job spec `server.js` generates, and confirmed
during a real production investigation (see session log for detail):

- **Memory limits are real and enforced** (Docker/cgroup-level, per
  container) — confirmed via an actual OOM incident where the kernel
  killed one container's process without affecting others. Since memory
  oversubscription, the enforced number is the job spec's `memory_max`
  (256/512MB — the same value that used to be the flat reservation), NOT
  its `memory`, which is only what the scheduler bin-packs against
  (32MB, universal — the higher embedded-DB tier was removed with PGlite).
  Requires `nomad operator scheduler set-config
  -memory-oversubscription=true` cluster-wide, done by
  `Server-setup/server-setup.sh` — with it off Nomad silently ignores
  `memory_max` and the low floor becomes a hard cap instead. See
  `docs/Memory-oversubscription-req.md`.
- **CPU limits are NOT hard-enforced today.** The job spec's `cpu = 100`
  becomes a relative `--cpu-shares` weight, not a cap, unless the Nomad
  client config sets `cpu_hard_limit = true` (unconfirmed whether it is).
  A CPU-heavy app can degrade others under contention.
- **Disk quota is likely NOT enforced.** `ephemeral_disk { size = 500 }`
  looks like a scheduling hint, not something that stops a container from
  writing past it. A runaway app could fill the shared host disk.
- **Network isolation between app containers is unverified** — whether
  one app can reach another directly over Docker's internal network,
  bypassing Traefik, has never actually been tested.

If work in this repo touches resource limits, job spec generation, or
container networking, treat closing these gaps as in-scope, not a
separate future task — this is the right place to fix them.

## The still-open production mystery

A prior incident (`railpack build` exiting successfully but producing no
Docker image) was investigated but never fully root-caused — a retry
happened to succeed before deeper diagnosis. **Still recommended and not
yet implemented**: after the Railpack build step, explicitly verify the
image exists (`docker image inspect <imageName>`) and throw a real error
if it doesn't, rather than trusting the build command's exit code alone.
See the session log for the full investigation trail.

## Also part of this repo (if applicable — confirm)

If the client-facing `hostnsoft-deploy` skill package (the `SKILL.md` +
`scripts/deploy.sh` + `scripts/troubleshoot.md` + `scripts/check-app-db.sh`
bundle that clients/agents use to package and call this API) also lives
in this repo, keep it in sync with `server.js`'s actual behavior — e.g.
the client-side pre-flight `window.storage` check in `deploy.sh` should
stay consistent with `detect-storage-usage.js`'s server-side logic. If
that skill package lives somewhere else instead, note the actual location
here so this doc stays accurate.

**Still not done, needed following the 2026-08-26 auth change above**:
the skill now lives at `../hostnsoft-skill/` (its own repo, checked out
locally as of 2026-09-02 — the `HOSTNSOFT_TOKEN` → `DEPLOY_TOKEN` rename
from the Embarko rebrand has been applied there, see that repo's own
notes) but its `deploy.sh` and `SKILL.md` still only send the token —
**no `X-Company-Id` header at all**. Every deploy through that skill
still gets a 400 until it's updated to send one (as a new required env
var, e.g. `COMPANY_ID`, alongside `DEPLOY_TOKEN`). This is a separate,
still-open gap from the rename — flagging it again explicitly rather
than letting it look resolved just because the skill source is no longer
missing.
