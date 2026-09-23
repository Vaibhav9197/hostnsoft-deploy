/**
 * GET /capabilities — the machine-readable contract an agent reads BEFORE
 * it designs or deploys an app.
 *
 * The rule for this file, and it is the whole point of it: state only what
 * the platform actually does. A capability document that advertises a
 * feature we don't have is worse than no document at all — an agent
 * designs around it, writes code against it, and the human pays for the
 * wasted round trip. Two consequences of that rule, both deliberate:
 *
 *   - `features` says WHO can invoke each one. Rollback, env vars and
 *     custom domains exist, but only through the dashboard's session
 *     credential — a deploy token cannot reach them. An agent that knows
 *     this hands the job to the human instead of failing at it.
 *   - Limits that aren't enforced anywhere are OMITTED, not guessed. We
 *     currently set no upload ceiling, no build timeout, and no cap on
 *     memoryMb; publishing invented numbers for those would be fiction.
 *     When each one is actually enforced, add it here in the same commit.
 *
 * Served unauthenticated and cached: it's the same answer for everyone and
 * an agent shouldn't pay a round trip to re-read it mid-task.
 */
const crypto = require('crypto');

const CAPABILITIES = {
  capabilities_version: '2026-09-23',

  // Where an agent goes for anything beyond deploy/status/logs. Same
  // deploy token, addressed by app name rather than by the internal ids
  // the dashboard uses.
  control_plane: {
    base: 'https://ship.embarko.ai/api/apps/<app-name>',
    auth: 'Authorization: Bearer <deploy token>',
    operations: {
      get_app: 'GET /',
      list_env_vars: 'GET /env-vars',
      set_env_vars: 'PUT /env-vars',
      update_env_var: 'PUT /env-vars/<key>',
      delete_env_var: 'DELETE /env-vars/<key>',
      apply_env_vars: 'POST /env-vars/apply',
      list_deployments: 'GET /deployments',
      get_deployment: 'GET /deployments/<id>',
      rollback: 'POST /rollback',
    },
    // Reading a value back is deliberately not offered — see the
    // env-vars route's own comment.
    env_var_values_readable: false,
    // Env vars are baked into the job spec at deploy time, so a write
    // alone never reaches the running container. `apply` re-pushes the
    // current image with the new values — no rebuild, no source upload.
    env_var_writes_need_apply: true,
  },

  // The contract an app's own code has to satisfy to run here at all.
  runtime: {
    port_env: 'PORT',
    bind_address: '0.0.0.0',
    dockerfile: 'rejected',
    builder: 'railpack',
    detects: ['node', 'python', 'go', 'ruby', 'php', 'rust', 'java', 'static'],
  },

  // How an agent obtains and keeps a credential. `file` is the convention
  // the skill implements — an agent that acquires a token writes it here
  // and stops asking on every later deploy.
  credentials: {
    env_var: 'DEPLOY_TOKEN',
    file: '~/.embarko/credentials',
    acquisition: [
      {
        method: 'email_token',
        endpoint: 'POST https://ship.embarko.ai/api/public/deploy-tokens/request',
        body: { email: '<address>' },
        response: '202 always — the token is emailed, never returned in the response',
        human_step: 'reads the token from their inbox and pastes it back',
        needs_browser: false,
      },
      {
        method: 'dashboard',
        url: 'https://embarko.ai/app/tokens',
        human_step: 'signs in and creates a token',
        needs_browser: true,
      },
    ],
    scoped_to: 'company',
    expires: false,
  },

  // Deploying with no Authorization header at all is supported and
  // produces a real, live app on a deadline. The authoritative expiry for
  // any given app is the `expiresAt` in that deploy's own response — this
  // is the default an agent can plan around before deploying.
  anonymous_deploy: {
    supported: true,
    expires_after_hours: 24,
    on_expiry: 'deleted',
    claims_by: 'redeploy_with_credential',
  },

  // What survives what. `survives_node_loss: false` is the single most
  // important field here: DATA_DIR is scheduler node-affinity, not durable
  // storage, and an agent choosing where to put a database needs to know
  // that before it writes the code rather than after the node is gone.
  persistence: {
    data_dir_env: 'DATA_DIR',
    durability: 'node_local',
    survives_redeploy: true,
    // NEW: DATA_DIR is a host directory bind-mounted into the container,
    // not the Nomad allocation's own ephemeral disk — so it now also
    // survives the app being STOPPED, which the allocation-scoped version
    // did not (Nomad garbage-collects a stopped job's alloc dir). This is
    // what makes scale-to-zero safe for an app with a database.
    survives_stop: true,
    // Still node_local: a bind mount is a path on ONE box. Nothing here
    // replicates, and an agent choosing where to put a database needs to
    // know that before it writes the code rather than after the node is
    // gone.
    survives_node_loss: false,
    backups: false,
  },

  // Opt-in at deploy time via `X-Scale-To-Zero: true` on POST /apps.
  //
  // Stated here because an agent has to decide BEFORE writing the app
  // whether a cold start is acceptable for what it is building — a
  // cron-driven webhook receiver, say, is a very different answer from a
  // live dashboard. Absent the header nothing changes, which is why the
  // default is spelled out rather than implied.
  //
  // The listed constraints are the ones actually enforced by
  // idle-report.js before every single stop, not aspirations: an app
  // failing any of them is reported and left running.
  scale_to_zero: {
    supported: true,
    opt_in_header: 'X-Scale-To-Zero: true',
    default: 'always_on',
    idle_threshold_minutes: Number(process.env.IDLE_THRESHOLD_MIN) || 360,
    // Measured in production, 2026-09-21/22: ~0.8s for Nomad to place the
    // allocation, 3.5-9s to a complete first response. The request is HELD
    // through the cold start, never refused.
    typical_cold_start_seconds: '4-9',
    requirements: [
      'writes any persistent state under DATA_DIR (see persistence above)',
      'tolerates the process restarting between requests — in-memory state is lost',
    ],
    notes: [
      'WebSockets are NOT supported under scale-to-zero: a live connection is invisible to idle detection, so the app can be slept while users are connected.',
      'Automated traffic (credential scanners, crawlers) will NOT wake a sleeping app; it gets a 404.',
      'A stopped app is woken by the first real request, which is held until the app answers.',
    ],
  },

  // status: available | preview | unavailable
  // via:    who can actually invoke it today
  features: {
    deploy: { status: 'available', via: ['agent', 'dashboard'] },
    scale_to_zero: { status: 'available', via: ['agent'] },
    redeploy: { status: 'available', via: ['agent', 'dashboard'] },
    deploy_status: { status: 'available', via: ['agent', 'dashboard'] },
    logs: { status: 'available', via: ['agent', 'dashboard'] },
    feedback: { status: 'available', via: ['agent', 'dashboard'] },
    // An agent reaches these with its deploy token, addressed by app name,
    // under https://ship.embarko.ai/api/apps/<name>/... — see
    // hostnsoft-api's routes/agentApps.routes.ts.
    env_vars: { status: 'available', via: ['agent', 'dashboard'] },
    rollback: { status: 'available', via: ['agent', 'dashboard'] },
    deployment_history: { status: 'available', via: ['agent', 'dashboard'] },
    // The register/verify/delete calls are agent-callable; creating the
    // actual DNS record still requires a human at their own registrar,
    // so an agent can drive most of this flow but not all of it.
    custom_domains: { status: 'available', via: ['agent', 'dashboard'] },
    rename_app: { status: 'available', via: ['agent', 'dashboard'] },
    memory_config: { status: 'available', via: ['dashboard'] },
    // Irreversible with no backup. Agent path requires the caller to
    // resend the app's own name as confirmation — a deploy token alone
    // (requestable by email, no further verification) isn't enough.
    delete_app: { status: 'available', via: ['agent', 'dashboard'] },
    analytics: { status: 'available', via: ['agent', 'dashboard'] },
    secrets: { status: 'unavailable' },
    scheduled_jobs: { status: 'unavailable' },
    background_workers: { status: 'unavailable' },
    managed_database: { status: 'unavailable' },
    backups: { status: 'unavailable' },
  },

  // Only values the code actually enforces. See the header comment.
  limits: {
    // Ceiling (Nomad `memory_max`), i.e. the most a task may use and the
    // number it gets OOM-killed at — the number that matters when sizing
    // an app. Tasks are SCHEDULED against the much lower floor below and
    // burst up to the ceiling when the host has room, so memory above the
    // floor is best-effort rather than reserved. One universal tier: the
    // higher embedded-database tier existed only for PGlite, which is no
    // longer supported. See docs/Memory-oversubscription-req.md.
    memory_mb_default: 256,
    memory_mb_scheduling_floor: 32,
    app_name_pattern: '^[a-z0-9-]+$',
    app_name_scope: 'platform_wide',
    app_name_min_length: 3,
    app_name_max_length: 63,
    // An app name becomes a hostname, so some are kept by the platform.
    // Published here so a name can be chosen before packaging and
    // uploading, rather than learning it from a rejected deploy. Refused
    // with code "app_name_reserved" — unlike "app_name_taken", this one
    // never becomes available, so don't retry it.
    app_name_reserved_examples: ['ship', 'api', 'www', 'login', 'docs', 'admin', 'mail'],
    app_name_reserved_url: 'https://embarko.ai/docs#app-names',
    app_version_pattern: '^[a-zA-Z0-9._-]+$',
  },

  // APIs that are rejected at deploy time, before a build is attempted.
  unsupported_apis: [
    {
      api: 'window.storage',
      reason: 'Specific to the Claude Artifacts sandbox; does not exist here.',
      http_status: 422,
      code: 'unsupported_storage_pattern',
      use_instead: ['better-sqlite3'],
    },
  ],

  docs: {
    reference: 'https://embarko.ai/docs',
    troubleshooting: 'https://embarko.ai/troubleshoot',
    skill: 'npx skills add embarko-ai/skill --skill embarko-deploy -g',
  },
};

// Computed once at load: the document is a constant, so its ETag is too.
const CAPABILITIES_BODY = JSON.stringify(CAPABILITIES);
const CAPABILITIES_ETAG = `"${crypto.createHash('sha256').update(CAPABILITIES_BODY).digest('hex').slice(0, 32)}"`;

module.exports = { CAPABILITIES, CAPABILITIES_BODY, CAPABILITIES_ETAG };
