# Free-plan footer: switching it without a restart

## What it is

Every orphan and free-plan app shows a "hosted on Embarko" footer (with
the Embarko logo), injected into its HTML by the `orphan-proxy` sidecar
(`orphan-proxy/proxy.js`). Paid plans don't show it. The app's own code
and image are never touched.

| App kind | How the footer gets there |
|---|---|
| Container | Its own `orphan-proxy` sidecar task in the Nomad job, present when `isOrphan \|\| isFreePlan` at the last job build |
| Static | The shared proxy in front of the static server, enabled per request by the `X-Embarko-Footer: 1` header in the app's router file |

## The flag

For container apps, whether the sidecar actually injects the footer is a
file, not a job setting:

```
host:      $APP_DATA_ROOT/.footer/<app>/show     "1" or "0"
sidecar:   /embarko-footer/show                  (directory bind-mounted read-only)
```

- `proxy.js` starts from env `FOOTER`, then re-reads `FOOTER_FLAG_FILE`
  every 5s. Missing, unreadable or unexpected content keeps the last
  value, so a file problem never flips the footer.
- The flag controls the footer only. An orphan's expiry banner is shown
  regardless; its footer follows the flag like any other app's (written
  `1` on deploy, so it shows unless switched off).
- The directory is mounted, not the file: the flag is replaced by
  rename (`footer-flag.js`), and a single-file bind mount would keep
  pointing at the old file.
- It lives beside `.specs` and `.snapshots`, not in the app's data
  directory — that one is mounted read-write at `/data`, and an app must
  not be able to turn its own footer off.

| Event | Flag |
|---|---|
| Deploy (container) | Written before `nomad job run`: `isOrphan \|\| isFreePlan` |
| `POST .../config` | Written from `isFreePlan` |
| `POST .../rename` | Written for the new name before its job runs; old name's removed after the point of no return, new name's removed on rollback |
| `POST .../footer` | Rewritten from `show` |
| `DELETE /internal/apps/:app` | Removed |

## `POST /internal/apps/:appName/footer`

Internal (`X-Internal-Secret`). Called by hostnsoft-api when a company's
plan changes, once per app.

Body: `{ "show": true | false }`

| Response | Meaning |
|---|---|
| `200 { applied: true }` | Visitors see the change within ~5s. No restart. |
| `409 { applied: false, code: "config_push_required", kind }` | The flag can't do it alone. Call `POST .../config` with the app's full config and `isFreePlan` instead. |
| `404 { code: "app_not_found" }` | No job (live or saved for scale-to-zero) on this host. |
| `400` | Bad app name, or `show` not a boolean. |

`config_push_required` happens for:
- a **static** app — its footer is the router-file header (the push
  rewrites the router; no restart);
- switching **on** for a job with **no sidecar** — deployed while the
  company was paying (one restart);
- a sidecar from **before the flag existed** — no mount yet (one
  restart; after it, every switch is flag-only).

The flag is written in every case except 404, so it always matches the
plan. Job lookups use `nomad-job.js`'s exact-ID `getNomadJob`, falling
back to the saved spec (`.specs/<app>.json`) for a scaled-to-zero app.

## `isFreePlan` on config push and rename

`POST /internal/apps/:appName/config` and `POST .../rename` take an
optional boolean `isFreePlan`. Before it existed, both rebuilt the app
as if paid, so a free app lost its footer on any custom domain, env var
change, rollback or rename. Absent means `false` — the old behavior — so
the deploy service can ship before hostnsoft-api sends it.
