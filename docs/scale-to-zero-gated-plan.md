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
| 4 | Activator (wake-on-request) | **Done** — verified in prod 2026-09-18 |
| 5 | Unattended 24-48h run | **Done** — 2026-09-21, window closed and verified |
| 6 | A few real, consenting apps | **Next** |
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
- [x] Check whether any existing app has data in an old alloc dir that
      needs a one-time copy:
      `ls -la /opt/nomad/data/alloc/*/alloc/data/ 2>/dev/null`
      **Audited 2026-09-18** — see "Migration status" below.

### Migration status as of 2026-09-18 — most apps are NOT migrated

`migrate-app-data.sh` (dry run) plus a per-app read of the running spec:

- **28 of 36 running apps still have `DATA_DIR=/alloc/data`** and no bind
  mount. An app only moves onto the host directory on its NEXT deploy, so
  "the platform was fixed" and "this app is safe to stop" are different
  statements — and for most apps the second is still false.
- **8 are migrated**: `commonground-campus-9f2d`, `demo-python`, `focus`,
  `frontend`, `pushpendra-agrawal`, `recall-brain-delta-457666`,
  `scale-to-zero-test-1`, `viasocket-embed`.
- **5 have real files in an allocation directory**: `assetdesk`,
  `assetdesk-v2`, `embarko-site`, `hostnsoft-panel-test` (all still on
  `/alloc/data`) and `focus` (migrated; its allocation copy is stale
  leftovers, and its destination is correctly newer and larger).
- The four unmigrated ones already have a byte-identical copy at
  `$APP_DATA_ROOT/<app>` from an earlier `--copy` run. That copy is
  current only because none of them has written since 8-11 September.

**Nothing is at risk today**: an allocation directory is only collected
when its job STOPS, `STOPPABLE_APPS` contains one throwaway test app, and
all 36 are running.

**It is a hard precondition for Step 6.** Adding any `/alloc/data` app to
the allowlist would destroy its data on the first stop — silently, because
an app that wakes to a missing database does not crash, it creates a fresh
one and reports itself healthy.

Two things follow:

1. `idle-report.js` now refuses to stop an app whose old `DATA_DIR`
   actually **contains** something. An old `DATA_DIR` is not by itself a
   reason to refuse: 28 apps are on `/alloc/data` and only 4 have a single
   file between them, so a blanket refusal would block Step 6 on
   redeploying two dozen apps that have nothing to lose. The question is
   not which path `DATA_DIR` points at, it is whether anything is there.
   Read over Nomad's client filesystem API, since allocation directories
   are root-owned 0700 and this runs as the deploy-service user; "could
   not tell" is treated as unsafe. A human reviewing a list of app names
   for the allowlist cannot see any of this; the code can.
2. **Four apps need migrating** before they could join the allowlist:
   `assetdesk`, `assetdesk-v2`, `embarko-site`, `hostnsoft-panel-test`.
   `focus` does not — it is already on the bind mount, and
   `migrate-app-data.sh` now skips apps whose running spec says `/data`
   rather than listing them as candidates. That listing was dangerous, not
   merely noisy: `--copy --force` on `focus` would have rsync'd a
   five-day-old allocation copy over live data, and an old `-wal` written
   over a newer `.db` can corrupt the database rather than just roll it
   back. The script now also refuses any copy where the destination is
   newer than the source, whatever `--force` says.
3. Migrating an app is **not** just a redeploy. The existing copies are
   point-in-time, so anything written between the copy and the redeploy
   stays in the old location and is lost. The sequence is
   `--copy` -> `nomad job stop <app>` -> `--copy --force` -> redeploy, per
   that script's own header.

`migrate-app-data.sh` also gained a guard while doing this audit: run
without sudo it could not read the root-owned, 0700 allocation
directories, every read swallowed its own error, and every app was
reported as having nothing to migrate. A confident all-clear over stranded
customer data. It now refuses to run rather than produce that.

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

**Status: done — verified in prod on 2026-09-18.** A real request to a
stopped app:

```
cold start requested → data verified (3 file(s), 1046296 bytes)
job submitted (+315ms) → awake at 156.238.99.173:28025 (+832ms)
GET / served in 4796ms          (curl: status=200 total=5.049436s)
```

**~5 seconds end to end**, of which the app's own boot is nearly all of
it — Nomad placement was under a second. That is the number Step 5 needs
in order to pick an idle threshold: the cold-start cost is small enough
that a fairly aggressive threshold is defensible.

Also confirmed on the same cycle: the manifest grew 1,038,056 →
1,046,296 bytes across stop → GC → wake, so the app is writing to data
that genuinely survived all three.

The other three checks: 10 simultaneous requests to a stopped app all
returned 200 and produced exactly ONE `cold start requested` — the
single-flight guard holds. An app whose image was removed returned 503 in
0.14s with an accurate message, rather than the seven-minute `pull access
denied` this used to produce. And no request for any other app ever
reached the activator.

 `deploy-service/activator.js`, its
own pm2 process (`<env>-activator`, `127.0.0.1:4200+offset`) rather than
an endpoint inside deploy-service — it holds visitor connections open for
the length of a cold start and must not be able to take the deploy API
down with it.

**How a request reaches it.** App routers come from Traefik's Nomad
provider, which only sees *running* services, so a stopped app has no
router and its hostname 404s. `/opt/traefik/dynamic.yml` declares a
fallback router per app at `priority: 1`. App routers set no explicit
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

**The blocker found on the first real wake: Nomad was deleting the
image.** The Docker plugin in `nomad.hcl` carried no `gc` block, so the
driver's defaults applied — `gc.image = true`, `image_delay = "3m"`. Once
a stopped job's allocations were garbage collected, Nomad deleted the
image itself. App images are built locally by railpack, pushed to no
registry, and referenced with `force_pull = false`, so this destroyed the
only copy in existence. Stopping an app quietly made it unrecoverable
three minutes later.

It surfaced as `pull access denied for scale-to-zero-test-1, repository
does not exist or may require 'docker login'` — which reads as a registry
credentials problem and is nothing of the sort. The deployment then
burned four allocations against its restart policy and failed on the
progress deadline, seven minutes later.

Three changes, in order of what actually fixes it:

1. `nomad.hcl` now sets `gc { image = false }` in the docker plugin.
   Off rather than a longer `image_delay`, because deploy-service already
   owns image lifecycle completely — `pruneOldImages()` keeps
   `IMAGE_RETAIN_COUNT` versions per app after each deploy, and teardown
   removes an app's images on delete. Nomad's GC was a second,
   uncoordinated policy on top of that, and it could also delete the
   image behind an older `imageTag` that one-click rollback depends on.
2. `idle-report.js` verifies every image in the captured spec is present
   before stopping, and aborts the stop if any is missing — the same rule
   as capturing the spec itself: **do not stop what you cannot restart**.
3. `activator.js` checks the same thing before submitting, so a missing
   image is an immediate, accurate error rather than a seven-minute
   deployment failure blaming Docker credentials.

**Requires a `server-setup.sh` run**, since `nomad.hcl` changing means
Nomad restarts.

**Known gap found on 2026-09-18 — the post-stop blackout window.**
Traefik's Nomad provider polls on a refresh interval (15s by default).
Between an app being stopped and Traefik noticing, Traefik still holds
that app's OWN router, pointing at a dead allocation — so a request in
that window gets a fast 502 and never falls through to the priority-1
activator router that would have woken it. Observed directly: 10 requests
sent seconds after a stop all failed, and the activator logged nothing at
all.

`server-setup.sh` now sets `--providers.nomad.refreshInterval=5s`, which
shortens the window; nothing can close it, because Traefik's view of a
stopped job can never be instantaneous. Two things follow:

- Any test of wake behaviour must wait past the refresh interval after a
  stop, or it is testing the stale router instead.
- Step 5 should MEASURE this rather than assume 5s — it is the one
  remaining case where a real visitor sees an error rather than a slow
  page, and it is the strongest argument for a generous idle threshold
  (fewer stops means fewer windows).

**Known limit — custom domains are not covered.** The fallback router
matches only the app's default `<app>.<APPS_DOMAIN_SUFFIX>` hostname.
`nomad-job-spec.js` also emits a router per custom domain, and those
disappear with the job like any other Nomad-provider router — so a
stopped app with a custom domain still 404s on that domain. Harmless
while the only stoppable app is a throwaway test app with no custom
domain, but it MUST be fixed before Step 6 puts a real app on this: a
customer's own domain going dark is the most visible possible failure.

**Deploying this needs `server-setup.sh`, not `redeploy.sh`** — the
router lives in root-owned `/opt/traefik/dynamic.yml`, which only
`server-setup.sh` generates. That run restarts Nomad, Docker and Traefik
and briefly drops every customer app.

**Verification before moving on**:
- [x] With the test app stopped (via Step 3), send it a real HTTP
      request — confirm the request is held (not an immediate error),
      the app cold-starts, and the *original* request gets a correct
      response (not just "app started," the actual expected content).
- [x] Send several requests simultaneously during a cold start — confirm
      this doesn't trigger multiple redundant `nomad job run` calls for
      the same app.
- [x] Deliberately break the test app so it can't start — confirm the
      activator returns a clean error after a reasonable timeout,
      instead of hanging forever.
- [x] Confirm no other app's traffic ever passes through this new proxy
      component at all.

---

## Step 5: Run Steps 3+4 together, unattended, over a real time window

**What this builds**: nothing new — this step is purely about proving
stability, not adding features.

**Deliverable**: idle-detection runs on a schedule (cron/systemd timer)
for the one test app, cycling automatically through
idle → stop → request → wake → serve → idle, with no manual intervention.

**Status: soak running in prod since 2026-09-18 11:35 UTC.** Started with
`scale-to-zero-soak.sh prod`; both timers confirmed scheduled via
`systemctl list-timers`.

Three bugs in the harness itself had to be fixed first, all of them
systemd/bash subtleties that pass `bash -n` and fail only at runtime:

- `OnUnitActiveSec` on a `Type=oneshot` whose run can last 150s left no
  computable next elapse. Now `OnUnitInactiveSec`, which also gives the
  interval its intended meaning: 45 minutes of idleness AFTER a request.
- `OnBootSec` is measured from boot, so on a long-running box its deadline
  is permanently past and produces no trigger — leaving a freshly
  installed timer with nothing to anchor to at all. Now `OnActiveSec`,
  relative to when the timer itself starts. The production idle timer had
  the same latent bug and escaped it only by luck.
- `systemctl list-unit-files | grep -q` under `set -o pipefail`: `grep -q`
  exits on first match, the still-writing upstream takes SIGPIPE and exits
  141, and the pipeline reports 141 — so a SUCCESSFUL match reads as a
  failure. It passed initially (the listing fit in the 64KB pipe buffer)
  and began failing permanently once two more unit files pushed it over.
  Worth remembering as a shape: worked in testing, then failed for reasons
  unrelated to any code change.


Two things this step needs that the plan did not call out:

- **Synthetic traffic.** `scale-to-zero-test-1` has no real users, so on a
  schedule it would stop once and stay stopped — exercising the stop path
  and never the wake path, which is the half that can lose data.
- **A deliberately short threshold.** Production is 6 hours; at that rate
  a 24h soak gives about four cycles, far too few to shake out a race.

`server-setup.sh` installs the production watcher as a systemd timer
(`embarko-idle-<env>`, every 10 min, `IDLE_THRESHOLD_MIN` default 360,
running as APP_USER so it cannot leave root-owned WAL files beside the
analytics database). `scale-to-zero-soak.sh <env>` layers the test
instruments on top: a drop-in shortening the threshold to 15 min, and a
timer requesting the test app every 45 min — about 30 full cycles a day.
`--remove` takes both away and restores the real threshold without a
re-provision. A drop-in rather than an edit so `server-setup.sh` can never
bake the test value into production.

**Scheduling does not widen what may be stopped.** That is still
`STOPPABLE_APPS`, frozen in `idle-report.js`. At a 15-minute threshold
nearly every app on the box reports as idle and every one of them is still
left running — which is itself part of what the soak tests.

**The threshold: 360 minutes (6 hours).** Chosen around the cost of
STOPPING, not waking. Waking is graceful — ~5s, a slow page then correct
content. Stopping is not: for a few seconds afterwards Traefik still
routes to the dead allocation and a request gets a hard 502. So what
matters is how OFTEN an app stops, not how long it stays stopped. Observed
working-day gaps run 4-6 hours (`viasocket` 4h11, `socket-ux` 5h42,
`embarko-homepage-prototype` 5h50), so a shorter threshold makes apps
cycle during office hours, putting 502 windows exactly where the users
are. 6 hours pushes almost every stop into the night. Of 31 live apps, 22
were idle over 1h and 9 over 6h — so 6h gives up the evening savings to
avoid daytime churn, and recovers most of it overnight anyway.

Worth revisiting later, in this order: time-of-day awareness (6h by day,
1h between 22:00-06:00) recovers the evening window; and routing
scale-to-zero apps through the activator PERMANENTLY, proxying straight
through while the app runs, removes the blackout window altogether and
would allow a genuinely aggressive threshold. The latter costs a hop and
makes the activator an availability dependency — a Step 6 decision.

**What the soak is measuring**, beyond "no errors": the number of 502s
against the number of cycles. That ratio is the blackout window's real
cost, and it is the one number that should decide whether Step 6 needs the
always-front proxy first.

### Soak results — 20 hours, 2026-09-18 11:35 to 2026-09-19 05:00 UTC

**31 stop/wake cycles. 25 requests, all `200`. Zero 502s, zero aborts,
zero errors of any kind.** Cold starts held at 4.1-6.4s with no upward
drift across the run. The activator ran 16h with `unstable restarts 0`.

The result that matters:

```
"visits": 803,
"firstVisitEver": "2026-09-17T09:16:53.131Z"
```

Unbroken since before any of this — 803 visits across 31 stops, a Nomad
job GC, an image deletion, a failed deploy and a version bump. The data
directory grew 1,062,776 -> 4,181,472 bytes. No loss at any point.

### The blackout window: measured, then closed

Measured 2026-09-19 by stopping the app and requesting within a second,
repeatedly: **roughly one in three attempts returned `502` in ~0.07s** —
an instant hard error, never reaching the activator, never waking
anything. The window is real, not theoretical.

Closed by routing allowlisted apps through the activator
**permanently** rather than only once stopped: `dynamic.yml`'s per-app
router moves from `priority: 1` (below the ~44 Traefik derives from an
app router's rule length) to `priority: 500` (above any possible
rule-length value, far below the platform's own 10000/10100). Traefik
then never points at an allocation for these apps, so there is no moment
when it can point at a dead one. Narrowing `refreshInterval` shrinks the
window; only this removes it.

**Verified 2026-09-21**: the same stop-then-request-immediately loop that
produced a 502 in one attempt out of three now returns `200` every time,
at 4.4-5.3s — the request is held through the cold start instead of being
refused. `priority: 500` confirmed live in `dynamic.yml`.

`activator.js` needed three things to be a proxy rather than a wake-up
hook that happens to forward:

- **An address cache** (30s TTL *and* failure-driven invalidation) so the
  hot path makes no Nomad calls. A stale entry self-heals: a connection
  error drops it and falls through to the full resolve-and-wake path,
  which is safe to retry because nothing has been written back yet.
- **A keep-alive agent**, so an app's whole traffic doesn't open and tear
  down a TCP connection per request.
- **Upgrade (WebSocket) proxying.** Not a bonus — while this only handled
  stopped apps, upgrades never reached it and worked because nothing was
  in the way. Routed here permanently, an activator that cannot proxy an
  upgrade breaks them silently: the page loads, the socket never
  connects.

**The cost, stated plainly:** the activator is now an availability
dependency for allowlisted apps, not just for waking them. It already had
to be up for a stopped app to return; this extends that to serving a
running one. That is the trade for removing the only hard-error path in
the design.

**This also weakens the case for a 6-hour threshold**, which was chosen
around how often an app stops precisely because stopping was harmful. A
stop now costs only a ~5s cold start on the next request. 6 hours stays
as a conservative starting point for Step 6 — first real users — and
should be revisited with data rather than left there by inertia.

**What the soak did NOT test: the blackout window.** It requests every 45
minutes and the watcher stops the app 15-25 minutes before each request,
so every request arrived half an hour outside the window. 0/25 was
structurally guaranteed and says nothing about the risk. Measuring it
needs a request issued within seconds of a stop, repeated — still to do,
and still the gate on Step 6.

**A real problem the soak did find: snapshots grow without limit.** 36
snapshots, 127MB, from one trivial app in 20 hours. Every stop copies the
whole data directory and nothing removed the old ones. At the production
6h threshold a real app stops about four times a day, so a 500MB database
would write 2GB/day forever — and the first symptom would be a full disk
taking every app on the box down at once. `idle-report.js` now keeps
`SNAPSHOT_RETAIN_COUNT` (default 3) and prunes older ones, matched
narrowly by directory-name pattern so `latest-manifest.json` and the app's
own data cannot be caught by it.

Worth watching, not yet a problem: of that 4.1MB, `visits.db` is 28KB and
`visits.db-wal` is 4.1MB. The WAL is never checkpointed because the
container is killed rather than shut down, so it only grows. Fine at this
scale; for a long-lived real app it is a disk-growth question of its own.

**Verification before moving on**:
- [x] Let this run unattended for 24-48 hours.
- [ ] Confirm the test app's memory usage graph actually shows the
      expected pattern — near-zero during idle windows, normal during
      active windows.
- [x] Confirm zero errors, zero effect on any other app, over the whole
      observation window.

### Step 6 preconditions

1. **Restore the production idle threshold.** The soak drop-in still
   holds `IDLE_THRESHOLD_MIN=15`. Real apps on a 15-minute threshold would
   cycle through working hours, which is exactly what 360 exists to
   prevent. `scale-to-zero-soak.sh prod --remove` restores it.
2. **Job specs are now saved at DEPLOY time** (`server.js`'s
   `saveJobSpec`), not only immediately before a stop. Stop-time capture
   alone means the first stop is the only thing that ever creates the
   spec, so an app has no saved spec between joining the allowlist and
   stopping for the first time — and any failure in that one capture
   leaves an app that cannot be woken. Best-effort and after the deploy
   has succeeded: losing it costs the ability to scale that app to zero,
   which is opt-in, and failing a working deploy over a missing optional
   file would be the worse trade. The path now has a single definition,
   `specPathFor` in `nomad-job-spec.js`, since three files touch it and a
   disagreement would surface only as "cannot be woken", at the moment
   someone is waiting.
3. **Choose candidates with no custom domain.** The activator's routers
   cover only `<app>.app.<suffix>`; a stopped app with a custom domain
   still 404s on that domain. Sidestepped rather than fixed for now —
   fixing it properly needs the activator to resolve custom domain -> app
   via api-service.
4. **Candidates must already be on `DATA_DIR=/data`.** `idle-report.js`
   enforces this, but choosing an app that is already migrated avoids
   needing user-visible downtime to migrate it first. 28 of 36 apps were
   still on `/alloc/data` as of 2026-09-18.

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
