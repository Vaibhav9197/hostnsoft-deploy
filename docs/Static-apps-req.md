# Static apps: served directly — no image, no Nomad job

**Status: shipped 2026-09-22 for plain static sites (Railpack's
`staticfile` provider). Build-time SPAs (Vite, CRA, …) still go through
the container path — see "Next".**

## Why

A plain static app — an `index.html` at the upload root, a `public/`
directory, or a `Staticfile` — used to go through the same pipeline as a
server app: `railpack build` produced a 177MB image whose only job was to
run Railpack's bundled Caddy over the files, Nomad scheduled a container
for it (32MB scheduling floor, 256MB ceiling, ~29MB RSS idle, plus a 10MB
orphan-proxy sidecar while unclaimed), and Traefik routed to it through
the Nomad provider. None of that did anything a directory and one shared
file server cannot do. Single-file HTML artifacts are a large share of
what AI agents deploy here, so most deploys were paying for a build and a
container they did not need.

## What happens now

1. `POST /apps` extracts the upload and runs `railpack info --format json`
   on it (`build-plan.js`). Railpack's own verdict decides: a deploy start
   command of `caddy run …` with provider `staticfile` is a plain static
   site. Nothing of ours guesses at file names, so the fast path only ever
   takes an app the container path would have served with Caddy anyway.
2. The files are copied to `$STATIC_SITES_ROOT/<app>/versions/<version>/`
   and `current` is switched to them atomically (`static-site.js`).
   `.git`, `.env*` (what Railpack's Caddyfile hides) and symlinks (which
   Caddy would follow anywhere on the host) are left out.
3. A Traefik file-provider router file is written to
   `$TRAEFIK_DYNAMIC_DIR/static-<app>.yml` (`traefik-router-file.js`):
   same router names, cert resolvers and CSP middleware as the Nomad
   tags, plus a request-header middleware naming the app
   (`X-Embarko-App`). Access-log attribution in `analytics/` keeps
   working unchanged: `<app>@file` strips to `<app>` like `<app>@nomad`.
4. The shared static server — one Caddy (`static-server/Caddyfile`) run
   by the `<prefix>static-server` Nomad system job, bound to 127.0.0.1 —
   serves `/srv/static/<X-Embarko-App>/current` with Railpack's own
   staticfile Caddyfile semantics. Orphan apps route through one shared
   orphan-banner proxy in front of it (`orphan-proxy/proxy.js` in header
   mode), which reads the expiry and login URL from two more request
   headers the router sets.

The response is still a 202 with `statusUrl`, now with `kind: "static"`
and `memory: null`, and the deploy finishes within a second in the
background.

## How a static app is told apart from a Nomad job

`$STATIC_SITES_ROOT/<app>/manifest.json` existing IS the answer
(`static-site.js`'s `isStaticApp`, wrapped with the Nomad check in
`app-kind.js`'s `resolveAppKind`). hostnsoft-api never sends the kind;
it only ever names the app by slug, and this host is the source of truth
for what is deployed — the same way rollback trusts `docker image
inspect` and health trusts `nomad job status`.

- `GET /apps/:app/status`, `GET /internal/apps/:app/status` — health is
  `running` while `current` resolves to a directory; `kind` is included.
- `GET /apps/:app/logs` — `available: false` with a plain reason: no
  process, so no logs.
- `POST /internal/apps/:app/config` (rollback, custom domains, env-var
  apply) — `imageTag` keeps its `<app>:<version>` shape and the version
  names a directory. A missing version is the same `image_unavailable`
  404 with `retainCount`. `memoryMb`/`envVars` are ignored (nothing to
  apply them to); a push always clears orphan routing, as the container
  path drops the sidecar.
- `DELETE /internal/apps/:app` — kind-agnostic: purges the Nomad job if
  any, removes the router file, then the static directory, then the data
  dir / saved spec / images exactly as before. It never needs to know
  the kind; it removes whatever either kind leaves.
- `idle-report.js`, `analytics/resource-poller.js`, `activator.js` —
  discover apps through Nomad, so static apps are simply not candidates
  (nothing to stop, sample or wake). Platform jobs are skipped by
  `type = "system"` as well as by name.

## Changing kind: one direction only

- **Server app → static site: allowed.** A static site needs nothing a
  server app has, so the deploy publishes the files, writes the router
  file, then purges the Nomad job and its images. `DATA_DIR` is left
  alone (only delete removes data). The 202 message says the conversion
  happened and that it cannot be undone under this name. This is also
  how every static app that predates the fast path — a job running
  Railpack's Caddy over the same files — moves off its container on its
  next deploy, with no special case for it.
- **Static site → server app: refused** with **422 `app_kind_changed`**
  before anything is built. A server app needs routing, a data directory
  and settings the static app never had, and its rollback history would
  mix directories and images. The message tells the caller to deploy
  under a new app name.

Accepted edge case (decided 2026-09-22): an accidental static upload of a
server app (say, a tarball missing its package.json) converts it and
retires the job, where before it would have failed the build and left
the job running. The response message is the guard.

## Layout and config

```
$STATIC_SITES_ROOT/<app>/
  manifest.json            kind, provider, current, versions[], customDomains, spa
  versions/<version>/      the site files
  current -> versions/<v>  what Caddy serves (relative link, resolves inside the mount)
$TRAEFIK_DYNAMIC_DIR/static-<app>.yml   routers + middlewares + service, one file per app
```

Env (all required, fail-fast at startup; the setup scripts export them):
`STATIC_SITES_ROOT`, `TRAEFIK_DYNAMIC_DIR`, `STATIC_SERVER_PORT`,
`STATIC_ORPHAN_PROXY_PORT`. Version retention reuses `IMAGE_RETAIN_COUNT`.

Infra (embarko-server-setup, both `server-setup.sh` and
`local/local.server-setup.sh`): Traefik's file provider became
`--providers.file.directory=/etc/traefik/dynamic` with `watch` — the
platform's own routers moved to `<prefix>platform.yml` in that
directory, which also lets several environments coexist on one Traefik
without overwriting each other's file. A `<prefix>static-server` system
job runs `caddy:2-alpine` plus the orphan-proxy image in header mode,
ports 4300/4310 (+ the environment's port offset). The Caddyfile lives in
this repo and is copied by the setup scripts; Caddy's admin API is off,
so a Caddyfile change needs `nomad job restart -yes <prefix>static-server`
(the setup scripts do it; `local.redeploy.sh` does it when the file
changed).

## Security notes

- Only Traefik reaches the static server (loopback). Traefik's
  `customRequestHeaders` overwrites `X-Embarko-App` on every request, and
  the Caddyfile refuses anything not matching `^[a-z0-9-]+$` before using
  it as a path.
- `X-App-Version` is checked against `.`/`..` before it names a directory
  (`static-site.js`'s `assertSafeVersion`) — the image-tag pattern alone
  would allow both.
- Symlinks inside an upload are not copied: Caddy would follow them.

## Next

- Build-time SPAs (Vite, CRA, …): `railpack info` already reports them
  (`metadata.nodeIsSPA`, output dir in `plan.deploy.inputs`). Run the
  build with `railpack build --output <dir>`, publish `<dir>/app/<outputDir>`
  the same way, and set `X-Embarko-Spa: 1` in the router — the Caddyfile
  already falls back to `/index.html` for it. Build logs would need to be
  captured per version for `GET /apps/:app/logs`.
- Report `kind` to hostnsoft-api (an optional field on `Deployment`) so
  the dashboard can label static apps and hide memory / env-var controls.
