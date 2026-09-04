# Requirement: Deploy Without a Token (Anonymous / Orphan Projects)

## Purpose

Today, `POST /apps` always requires a valid company deploy token — a
customer (or an AI agent deploying on their behalf) can't try the
platform without first logging into the dashboard and creating one. This
adds a **token-optional** path: deploy without a token and get a real,
live app immediately, at the cost of it being **temporary** — deleted
automatically after 24 hours unless claimed with a token before then.

## Behavior summary

| | Token present | Token absent |
|---|---|---|
| App name never used before | Creates project under the token's company (**unchanged**) | Creates project with **no company**, flagged `isOrphan: true`, expires in 24h |
| App name belongs to an existing **orphan** project | Adopts it: clears `isOrphan`, sets `companyId`, cancels expiry, removes the injected banner (**new**) | Redeploys to the same orphan project, original expiry unchanged (**new**) |
| App name belongs to an existing **claimed** (non-orphan) project, different company | `409 app_name_taken` (**unchanged**) | `409 app_name_taken` — an anonymous caller can never touch a claimed project (**new**) |
| App name belongs to an existing claimed project, same company | Redeploys normally (**unchanged**) | Not reachable — the name is already claimed by a company, see above |

## Functional requirements

### 1. `POST /apps` accepts requests with no `Authorization` header

Currently this is a hard `401`. Going forward:
- **No `Authorization` header at all** → anonymous path (below).
- **A malformed/invalid/revoked token** → still `401 unauthorized`, same
  as today. Only a *missing* token opts into the anonymous path — a
  caller that tries and fails to authenticate should not silently fall
  back to "deploy anonymously instead," since that would mask real auth
  bugs (typo'd token, expired token) as a feature.

### 2. App name uniqueness is unchanged

`X-App-Name` is still unique **platform-wide**, orphan or not — an
orphan project occupies its name exactly like a claimed one, and the
existing `app_name_taken` (409) is what an anonymous caller sees if the
name collides with anyone else's project, claimed or orphan-owned-by-a-
different-anonymous-session.

### 3. Orphan project bookkeeping

An anonymous deploy creates a `Project` row exactly like today, except:
- `companyId` is `null` (the `Company` relation must become optional).
- `isOrphan: true`.
- `orphanExpiresAt`: **computed once, at creation** — `now + <TTL>` (see
  constraint #7 on making the TTL configurable). Stored explicitly rather
  than derived from `createdAt` at delete-time, so the customer-facing
  deletion time quoted in the deploy response stays accurate even if the
  TTL config value changes later for *new* projects.

Redeploying to the same still-orphan project (no token, same app name)
does **not** reset `orphanExpiresAt` — the 24h clock starts once, at
first creation, regardless of how many anonymous redeploys happen before
it's claimed or expires.

### 4. Deploy response for an anonymous deploy

The success response gets one additional field, `orphan`, alongside the
existing fields (`success`, `version`, `image`, `memory`, `url`) —
nothing existing is removed or renamed:

```json
{
  "success": true,
  "message": "Deployment successful!",
  "version": "abc1234",
  "image": "my-app:abc1234",
  "memory": "256MB",
  "url": "https://my-app.app.embarko.ai",
  "orphan": {
    "expiresAt": "2026-09-05T14:30:00.000Z",
    "message": "This app is temporary and will be deleted at 2026-09-05T14:30:00.000Z unless claimed. To keep it: 1) go to https://embarko.ai/login and sign in (or create an account), 2) create a company if you don't have one, 3) create a deploy token from that company's Tokens page, 4) redeploy this exact app name using that token as the Authorization header before the deadline above. Redeploying with a valid token before expiry permanently keeps this app and removes this notice."
  }
}
```

`orphan.message` is written as a **complete, self-contained instruction
sequence** — an AI agent relaying this to a human user should be able to
read it alone (without also reading platform docs) and correctly explain
"your app is live temporarily, here's exactly how to keep it." Word it
plainly enough that an agent won't need to guess at any step.

### 5. On-page notice for the deployed app itself

Inject a script into the build output before it's built, so anyone who
visits the live URL directly (not just whoever ran the deploy) sees the
same warning. Concretely: if the build output contains an `index.html`
at its root, inject a small inline `<script>` right before `</body>`
that renders a fixed, dismissible-or-not banner: *"This app will be
deleted at **HH:MM** — [log in to keep it](<login URL>)"*, computed from
the same `orphanExpiresAt` stored on the project.

**Known limitation, accepted rather than solved here**: this only works
for apps that produce a static `index.html` the platform can modify
post-build (most frontend frameworks). A pure backend/API-only app (no
HTML being served) has no generic injection point — such an app is still
tracked and deleted identically, it just won't display an in-app notice.
The deploy response's `orphan.message` (#4) is the notice of record
regardless; the injected banner is a bonus for browser-visited apps, not
the only channel.

### 6. Claiming an orphan project with a token

When a token **is** present and `X-App-Name` matches an existing orphan
project:
- Set `companyId` to the token's company.
- Clear `isOrphan` and `orphanExpiresAt`.
- Remove the injected banner script from the build **on this deploy** —
  since deploys always rebuild from the freshly uploaded source, this is
  automatic as long as the injection step (#5) is skipped whenever the
  request carries a valid token, not a separate removal step against
  already-running code.
- From this point on the project behaves exactly like any other
  token-created project — no trace of having been orphaned.

### 7. Cleanup job

A background job, **hourly**, deletes every `Project` where `isOrphan =
true` and `orphanExpiresAt` has passed. Deleting a project means
tearing down everything a normal project delete does *not* currently
handle (see the platform-wide known gap: today's `DELETE /projects/:id`
only removes the DB row) — for orphan cleanup specifically, actually
tear down:
- The Nomad job (which also removes its Traefik routing, since Traefik's
  Nomad provider derives config from the running job).
- Any Docker image(s) tagged for that app.
- The DB row (cascades to its `Deployment`/`EnvVar`/`Domain` rows same
  as any project delete already does).

Uploaded tarballs and build directories are already deleted immediately
after each deploy attempt today (success or failure) — nothing lingers
there that needs separate orphan cleanup.

The retention window (default 24h) is configurable via an environment
variable, read fresh by both the creation-time `orphanExpiresAt`
calculation and the cleanup job's query — changing it only affects
projects created after the change, not ones already given an expiry.

## Edge cases to handle explicitly

- **Anonymous redeploy racing the cleanup job**: if an anonymous redeploy
  to an orphan project lands at nearly the same moment the cleanup job
  is tearing it down, the redeploy must not resurrect a half-deleted
  project or the cleanup job must not delete a project mid-redeploy.
  Treat this the same way every other concurrent-mutation race in this
  codebase is handled: whichever operation's DB write lands second sees
  the other's result and reacts accordingly, rather than assuming
  exclusivity.
- **Claiming while a redeploy is in flight**: not specifically
  synchronized beyond the above — acceptable, since claiming only
  changes ownership fields and does not touch the running app.
- **An anonymous deploy of an app name that collides with an already-
  *expired-but-not-yet-cleaned-up* orphan** (the hourly job hasn't run
  yet): treat it as still existing/claimed by that orphan session until
  the cleanup job actually removes it — don't let a second anonymous
  caller silently take over a not-yet-deleted orphan's name and identity
  mid-window.

## Explicitly out of scope for this change

- No deployment-history recording (`/internal/deployments/record`) for
  anonymous deploys — there's no company to attribute the history to
  until/unless the project is claimed. Once claimed, history starts
  accumulating normally from that point forward; nothing is
  retroactively backfilled for the anonymous period.
- No rate limiting on anonymous deploys — a known gap, not solved here,
  consistent with other unrated internal endpoints already flagged
  elsewhere in this codebase.
- No email/notification to anyone when a project is about to expire —
  the only signals are the deploy response message and the in-app
  banner, both delivered once, at deploy time.
