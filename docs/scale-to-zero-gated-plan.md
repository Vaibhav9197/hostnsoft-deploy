# Scale-to-zero: gated development plan

**Rule for every step below**: nothing touches any real, currently-running
app until the mechanism has been proven safe on one dedicated throwaway
test app first. Each step ships something concrete, has an explicit
verification checklist, and work on the next step doesn't start until
you've confirmed the current one.

---

## Progress

**This file is the record of where scale-to-zero actually stands.** It
lives in the deploy-service repo, on the branch that is deployed, so the
progress survives a laptop, a context window and a re-provision — it was
previously only in a local `docs/` folder that is not a git repository at
all. Update the status line under a step in the SAME commit that
completes it.

| Step | What | Status |
|---|---|---|
| 0 | `DATA_DIR` on a host bind mount | **Shipped, live** — one GC check outstanding |
| 1 | Request activity tracking | **Done** |
| 2 | Idle detection, dry-run only | **Done** |
| 3 | Real stop, one hardcoded test app | **Done** — verified in prod 2026-09-17 |
| 4 | Activator (wake-on-request) | **Built, not yet verified** |
| 5 | Unattended 24-48h run | Not started |
| 6 | A few real, consenting apps | Not started |
| 7 | Opt-in via the deploy API | Not started |

A step is "Done" only when every box in its own verification checklist is
ticked. "Code shipped" is deliberately not the same thing: Step 3's code
has been deployed and dry-run, but it has never actually stopped
anything, so the mechanism it exists to prove is still unproven.

---

## Step 0: Move `DATA_DIR` off the allocation onto a host bind mount

**Status: shipped and live in prod.** Every app deploys with
`volumes = ["$APP_DATA_ROOT/<appName>:/data"]` and `DATA_DIR=/data`;
`deploy-service` creates and chmods the directory before every
`nomad job run`, and the DELETE endpoint removes it after the job stops.
Confirmed on `scale-to-zero-test-1`: `visits.db`, `visits.db-wal` (803KB)
and `visits.db-shm` all land on the host together — the `-wal` is where
the data actually was, which is exactly why the three files have to
travel as a set. The one box still open is the GC check, which Step 3's
first real stop will also answer.

**Why this comes first**: nothing may stop an app until its data is no
longer owned by the thing being stopped. `DATA_DIR` used to be
`/alloc/data` — Nomad's own allocation directory, which Nomad garbage
collects along with a stopped job (`job_gc_threshold`, 4h by default).
Any app with a SQLite database would wake up empty, and *silently*: an
app that finds no database usually just creates a fresh one and looks
perfectly healthy.

**Deliverable**: each app gets its own host directory
(`$APP_DATA_ROOT/<appName>`), bind-mounted into its container at `/data`,
with `DATA_DIR=/data`. Per-app, never a single shared Nomad
`host_volume` — a shared one would let every app read every other app's
database.

**Why not self-hosted Turso** (previously this step): by its own scope
note, migrating customer apps to Turso is opt-in and can't be forced, so
after all that work there would still be apps on local `DATA_DIR` files
and Step 3 still couldn't safely stop them. It also requires app code
changes, whereas this requires none. Turso remains worth doing for the
multi-node goal — tracked separately in
`self-hosted-turso-migration-guide.md`, which is no longer a prerequisite
for this plan. Note that guide has two unresolved issues: sqld bound to
`127.0.0.1` is unreachable from app containers (they have their own
network namespace — same discovery as `ORIGIN_IP` in
`nomad-job-spec.js`), and `~` doesn't expand in Compose volume paths.

**Verification before moving to Step 1**:
- [x] Deploy a test app that writes a SQLite database under `DATA_DIR`,
      confirm the file appears under `$APP_DATA_ROOT/<appName>/` on the
      host.
- [ ] Redeploy it — confirm the data is still there (no regression on
      the guarantee that already existed).
- [ ] `nomad job stop` it, wait past `job_gc_threshold`, re-run the job —
      confirm the data is STILL there. This is the whole point of the
      step; if this check fails, nothing after it is safe. Re-run it from
      the spec `idle-report.js` saved under `$APP_DATA_ROOT/.specs/`, NOT
      from Nomad: by the time this check is due, Nomad has GC'd the
      stopped job and no longer has the spec (see Step 3).
- [x] Confirm the container can actually write to the mount (Railpack
      images don't all run as root — deploy-service chmods each app's
      directory 0777 as it creates it).
- [ ] Confirm deleting an app removes its data directory, and that
      nothing else does.
- [ ] Check whether any existing app has data in an old alloc dir that
      needs a one-time copy:
      `ls -la /opt/nomad/data/alloc/*/alloc/data/ 2>/dev/null`

---

## Step 1: Request activity tracking (pure observation, zero risk)

**Status: done.** Needed no new component —
`analytics/access-log-tailer.js` already writes one row per request into
`request_log(app_name, ts)`, so last-seen is a `MAX(ts)`. What this step
DID need, and now has: a `user_agent` column (additive migration guarded
by `PRAGMA table_info`), Traefik configured to keep the header
(`--accesslog.fields.headers.names.User-Agent=keep`), and
`analytics/bot-filter.js` so a scanner hitting `/.env` cannot masquerade
as a user and keep an idle app awake forever. Verified live: apps' last-seen
updates promptly, `request_User-Agent` is populated, no app touched.

**What this builds**: a way to record "when was this app's URL last
actually requested" — per app, continuously updated. No app's running
state changes at all in this step.

**Deliverable**: a small process (log-tailer on Traefik's access logs,
or middleware) that writes a last-seen timestamp per app name to a
simple store.

**Why this is safe to build first**: it only *reads* traffic and
*records* data — it has no code path that stops, starts, or touches any
app's lifecycle. There is no way this step can break anything running.

**Verification before moving on**:
- [x] Send requests to 2-3 different real apps, confirm their tracked
      timestamps update correctly and promptly.
- [x] Confirm every currently-running app is completely unaffected —
      trivially true since nothing here touches app lifecycle, but
      explicitly check `nomad job status` shows no changes anywhere.

---

## Step 2: Idle-detection in dry-run only (report, don't act)

**Status: done.** `node idle-report.js` with no flags. Verified: real
idle apps correctly flagged, `deploy-service`/`api-service` never appear
at all (they run under pm2, not Nomad), `traefik` excluded via
`PLATFORM_JOBS`, and zero apps touched — the script has no code path that
can stop anything without `--apply`.

**What this builds**: logic that reads Step 1's data and identifies
"this app has had no traffic for N minutes" — but only **prints** what
it would do. Nothing is actually stopped yet.

**Deliverable**: a script, run manually, that outputs a list like
`app-x: idle for 47 min (would stop)` / `app-y: active 2 min ago (would not stop)`.

**Verification before moving on**:
- [x] Pick an app you know hasn't been used recently — confirm it's
      correctly flagged as idle.
- [x] Check `deploy-service`/`api-service` themselves (always active) —
      confirm they're correctly *not* flagged.
- [x] Confirm zero apps were actually touched — this step has no
      "apply" mode at all yet, so this should be trivially true.

---

## Step 3: Actual stop — hardcoded to exactly one throwaway test app

**Status: done — verified in prod on 2026-09-17.** A real `--apply` run
against 31 running apps: 22 idle apps listed under "Idle but NOT
stoppable" and left alone, `scale-to-zero-test-1` the only one stopped.
Afterwards `nomad job status` showed it as `dead (stopped)` — stopped,
not purged, so the job is still registered — and every other app still
`running`. Its spec was saved to `.specs/`, and the snapshot recorded 3
files / 1,038,056 bytes.

**The size split in that manifest is the point of the whole plan.**
`visits.db` is 4,096 bytes; `visits.db-wal` is 1,001,192. Essentially all
the data was in the write-ahead log, never checkpointed, because the
container was killed rather than shut down cleanly. An implementation
that persisted only the `.db` file would have looked entirely successful
and lost everything. SQLite recovers from the WAL on next open, but only
if all three files travel together — which is exactly what the host bind
mount from Step 0 guarantees and an allocation directory did not.

**What this builds**: the real "stop an idle app" action — but gated so
it can *only ever* act on one explicitly named test app, hardcoded, not
a general allowlist yet.

**Deliverable**: deploy a dedicated, disposable test app
(`scale-to-zero-test-1`, nothing real depends on it). Extend Step 2's
script with a real `nomad job stop` call, but only if the app name
exactly matches this one hardcoded value — a hard safety rail, not a
config option, so a bug here cannot reach any other app.

**Built as `deploy-service/idle-report.js --apply`.** Beyond the plain
stop, it also does three things the original step didn't specify but
which Step 4 depends on:
- **Guards before stopping**: aborts if there was traffic in the last
  60s (the idle threshold's resolution is too coarse to catch a request
  that lands between report and stop), and aborts if Nomad shows a
  deployment in flight. An unreachable Nomad counts as unsafe, not safe.
- **Never `-purge`**: a purged job is gone, spec and all, and could not
  be woken. Plain `nomad job stop` keeps it registered.
- **Snapshot + manifest after stopping**, when the files are quiescent
  (a copy of a live SQLite database can be torn; a copy of a stopped one
  cannot). The manifest records file count and per-file sizes so Step 4
  can assert the data is intact BEFORE serving a woken app — an app that
  wakes to an empty DATA_DIR usually just creates a fresh database and
  reports itself healthy, which is the silent-data-loss case.

**A prerequisite discovered while verifying this step: the job spec.**
`deploy-service` renders each app's spec into a temp build directory,
runs it and deletes the file (`server.js`), so after a deploy the only
copy lives in Nomad's own state — and `job_gc_threshold` (4h) collects a
*stopped* job out of that state. At that moment the spec is gone: nothing
for Step 4's activator to run, and no recovery short of a fresh deploy
from source. The window in which a stopped app can be woken was
therefore 4 hours, and it closed silently.

`idle-report.js` now runs `nomad job inspect` and writes the result to
`$APP_DATA_ROOT/.specs/<appName>.json` **before** the stop, and treats a
capture failure as a reason to abort the stop — an app we cannot prove we
can restart does not get stopped. `nomad job inspect` emits
`{"Job": {...}}`, which `nomad job run -json` takes back unchanged.
`server.js`'s delete endpoint removes the saved spec along with the data,
so deleting an app stays final rather than leaving a runnable description
of it where the activator looks.

**Still owed before Step 6**: this captures the spec at *stop* time, which
covers the apps this mechanism actually stops. Extending scale-to-zero to
real apps wants `server.js` persisting the spec at *deploy* time instead,
so a spec exists before anything has ever tried to stop the app.

**Verification before moving on**:
- [x] Let the test app sit idle past the threshold, run the script in
      apply mode, confirm `nomad job status scale-to-zero-test-1` shows
      it stopped.
- [x] Confirm every other app is still running exactly as before —
      check the full `nomad job status` list, and `curl` a couple of
      real apps directly to confirm they still respond normally.
- [x] Confirm the safety rail is actually doing work: the apply output
      must list other idle apps under "Idle but NOT stoppable". If no
      other app is idle, that line proves nothing — check again later.
- [x] Confirm the test app's data is STILL on disk after the stop, and
      that a snapshot plus `latest-manifest.json` were written.

---

## Step 4: The activator (wake-on-request) — same single test app only

**What this builds**: the proxy piece that catches a request for the
stopped test app, triggers a restart, waits for it to become healthy,
then forwards the original request through.

**Deliverable**: a small reverse proxy or middleware, routing only
requests for `scale-to-zero-test-1`'s hostname through this new logic —
every other app's traffic keeps flowing through Traefik exactly as
today, completely untouched by this new component.

**Status: built, not yet verified.** `deploy-service/activator.js`, its
own pm2 process (`<env>-activator`, `127.0.0.1:4200+offset`) rather than
an endpoint inside deploy-service — it holds visitor connections open for
the length of a cold start and must not be able to take the deploy API
down with it.

**How a request reaches it.** App routers come from Traefik's Nomad
provider, which only sees *running* services, so a stopped app has no
router and its hostname 404s. A file in `/opt/traefik/dynamic/` (Traefik's
file-provider directory since 2026-09-22 — previously the single
`/opt/traefik/dynamic.yml`) declares a fallback router per app at
`priority: 1`. App routers set no explicit
priority, so Traefik derives theirs from the rule's length (~44 for a
`Host` rule) — a running app outranks the fallback by a wide margin and
its traffic never touches the activator. One router per exact hostname,
never a wildcard, which is what makes "no other app's traffic reaches
this component" a fact about the config rather than a hope about the
code.

**What it does on a cold request**, in order: buffer the body (capped, so
a large upload at a sleeping app can't be used to exhaust it) → verify
the data directory against Step 3's `latest-manifest.json` → run the
saved spec from `.specs/` → wait for Nomad's service registry to have an
address → forward, retrying connection refusals until the app is actually
listening.

**The manifest check is the important one, and it runs BEFORE the start.**
An app that wakes to a missing database does not crash — it creates a
fresh one and reports itself healthy. Checking after the start would be
too late: the app is already writing, and the evidence of what was lost
goes with it. A mismatch is a hard 503, never a start-anyway. Sizes
rather than checksums: the files are quiescent between stop and wake, so
any difference at all is a problem, and this avoids reading a whole
database on every cold start.

**Deploying this needs `server-setup.sh`, not `redeploy.sh`** — the
router lives in `/opt/traefik/dynamic/<env-prefix>platform.yml`, which
only `server-setup.sh` generates. That run restarts Nomad, Docker and
Traefik and briefly drops every customer app. (Since the static fast path
that directory is owned by the deploy user and Traefik watches it, so a
fallback router could alternatively be dropped in as its own file there
without a re-provision — not done yet.)

**Verification before moving on**:
- [ ] With the test app stopped (via Step 3), send it a real HTTP
      request — confirm the request is held (not an immediate error),
      the app cold-starts, and the *original* request gets a correct
      response (not just "app started," the actual expected content).
- [ ] Send several requests simultaneously during a cold start — confirm
      this doesn't trigger multiple redundant `nomad job run` calls for
      the same app.
- [ ] Deliberately break the test app so it can't start — confirm the
      activator returns a clean error after a reasonable timeout,
      instead of hanging forever.
- [ ] Confirm no other app's traffic ever passes through this new proxy
      component at all.

---

## Step 5: Run Steps 3+4 together, unattended, over a real time window

**What this builds**: nothing new — this step is purely about proving
stability, not adding features.

**Deliverable**: idle-detection runs on a schedule (cron/systemd timer)
for the one test app, cycling automatically through
idle → stop → request → wake → serve → idle, with no manual intervention.

**Verification before moving on**:
- [ ] Let this run unattended for 24-48 hours.
- [ ] Confirm the test app's memory usage graph actually shows the
      expected pattern — near-zero during idle windows, normal during
      active windows.
- [ ] Confirm zero errors, zero effect on any other app, over the whole
      observation window.

---

## Step 6: Expand to a small number of real, consenting apps

**What this builds**: the same proven mechanism, now applied to a
handful of real apps whose owners have explicitly agreed to the
cold-start tradeoff — still an explicit allowlist, not a general
default.

**Deliverable**: 2-3 real (but non-critical) apps added to the
allowlist, with their owners informed beforehand.

**Verification before moving on**:
- [ ] Same checklist as Step 5, now for these specific apps.
- [ ] Confirm every app *not* on the allowlist remains completely
      unaffected — this is the most important check in this step,
      since it's the first time the mechanism runs against real traffic
      it wasn't purpose-built around.

---

## Step 7: Wire opt-in into `deploy-service`'s deploy API

**What this builds**: a way for *new* deploys to opt into scale-to-zero
at deploy time, instead of needing manual allowlist edits.

**Deliverable**: an optional header (e.g. `X-Scale-To-Zero: true`) on
`POST /apps`. When present, the new app is automatically registered
with the idle-watcher and activator. When absent — the default,
unchanged for every existing and future app that doesn't ask for
this — behavior is identical to today.

**Verification before moving on**:
- [ ] Deploy a brand-new test app *with* the header — confirm
      scale-to-zero works out of the box, no manual config needed.
- [ ] Deploy a brand-new test app *without* the header — confirm it
      behaves exactly like every other app today (always-on).
- [ ] Confirm every existing already-deployed app is completely
      unaffected by this change to `deploy-service`.

---

## Explicitly out of scope for this plan

- **Making scale-to-zero the default** for new deploys — a separate,
  later product decision once Step 6/7 have real-world validation, not
  something to fold into this build.
- **Firecracker/Kata warm-resume upgrade** — a planned later phase on
  top of a working cold-start system, not part of getting the basic
  mechanism shipped.
- **Broader rollout to all apps** — this plan only covers building and
  proving the mechanism safely; deciding how widely to offer it is a
  separate conversation once it's proven.
