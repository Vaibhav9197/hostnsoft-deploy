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
 *   - `features` says WHO can invoke each one, and that answer moves:
 *     several of these began dashboard-only and are now reachable with a
 *     deploy token. Read `via` rather than this comment — an earlier
 *     version of it listed the split by name and was wrong within weeks.
 *     An agent that reads `via` hands the dashboard-only ones to the
 *     human instead of failing at them. Keep the field honest in the same
 *     commit that moves a feature, or it becomes the fiction the rule
 *     above forbids.
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
  capabilities_version: '2026-10-02',

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
      change_app_address: 'POST /slug-change',
      change_app_address_status: 'GET https://ship.embarko.ai/api/slug-changes/<project-id>',
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

  // App shapes that will not work here, stated up front so an agent rules
  // them out BEFORE it writes the code. Not rejected at deploy time (unlike
  // unsupported_apis below) — the deploy succeeds and the feature silently
  // fails at runtime, which is exactly why it has to be said here.
  not_supported: [
    {
      feature: 'websockets',
      detail: 'WebSocket connections are not supported — this includes libraries built on them (Socket.IO, ws, Pusher-style realtime). Apps that need live push (chat, multiplayer, live dashboards) will not work.',
      use_instead: 'Plain HTTP requests, polling the server on an interval from the browser.',
    },
    {
      feature: 'cron_jobs',
      detail: 'Cron jobs and scheduled tasks are not supported. There is no platform scheduler, and an in-process one (node-cron, APScheduler, setInterval loops) is not guaranteed to run: the process restarts on every redeploy and may be stopped when idle.',
      use_instead: 'Expose an HTTP route that does the work, protect it with a secret env var, and call it from an external scheduler.',
    },
  ],

  // A plain static site — Railpack's "staticfile" provider: an index.html
  // at the upload root, a public/ directory, or a Staticfile — is not
  // built into an image and does not run as a container. Its files are
  // published to a shared static file server behind Traefik and are live
  // seconds after the upload is accepted (see docs/Static-apps-req.md).
  // Everything under `runtime` and `persistence` is about a SERVER app
  // and does not apply to it: nothing listens on PORT and DATA_DIR does
  // not exist. Env var and memory writes are refused (409
  // not_supported_for_static) rather than accepted and silently ignored.
  // A build-time SPA (Vite, CRA, ...) is still built and served in a
  // container today. The deploy response and status carry `app.kind`.
  static_apps: {
    served_directly: ['staticfile'],
    detected_by: 'railpack',
    build: false,
    container: false,
    live_within_seconds: true,
    env_vars: 'refused',
    memory_config: 'refused',
    refused_code: 'not_supported_for_static',
    logs: false,
    scale_to_zero: 'not_applicable',
    data_dir: false,
    // A server app may be redeployed as a static site (its job is
    // retired). A static site can NOT be redeployed as a server app: that
    // upload is refused before anything is built — use a new app name.
    server_to_static: 'allowed',
    static_to_server: { http_status: 422, code: 'app_kind_changed', fix: 'use a new X-App-Name' },
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

  // Optional `X-App-Type` on POST /apps (`appType` in a JSON-source body).
  // Listed here so an agent knows to fill it in or ask for it BEFORE the
  // first deploy, instead of learning about it afterwards.
  app_type: {
    header: 'X-App-Type',
    required: false,
    max_length: 60,
    examples: ['personal website', 'portfolio', 'landing page', 'blog', 'task management', 'feedback system', 'dashboard', 'e-commerce store'],
    how_to_choose: 'Use what you already know about the app. If it is unclear, ask the user once and say they can skip it. If they skip it, omit the header. A redeploy without it keeps the previous value.',
  },

  // Optional `X-Agent-Name` on POST /apps (`agentName` in a JSON body) and
  // on the agent API's rollback / env-var apply calls. Recorded on each
  // deployment so the owner can see which agent deployed what.
  agent_name: {
    header: 'X-Agent-Name',
    required: false,
    max_length: 60,
    examples: ['claude-code', 'claude', 'chatgpt', 'codex', 'cursor', 'copilot', 'gemini', 'windsurf'],
    how_to_choose: 'Send the name of the agent or product you are running as, in lowercase. It is only a label: it does not change what you can do.',
  },

  // What every reply from POST /apps, GET /apps/<name>/status and
  // GET /apps/<name>/logs looks like, so an agent knows how to read them
  // before the first deploy. Each reply gives the ONE next step for the
  // app's current state; later steps appear in later replies.
  deploy_flow: {
    reply_shape: '{ status, app, next, links } — errors keep { error, code } and add next + links',
    steps: [
      'deploy: POST /apps -> status "building" (server app, 202) or, for a static site, usually "live" already (200)',
      'confirm: if not live yet, poll links.status until status is "live"; on "failed" or "crashed" read links.logs and redeploy. If the deploy sent Authorization, send the same header on status and logs: a claimed app answers 404 without it',
      'claim: an app deployed without a token is temporary (see app.expiresAt); the live status reply says how to claim it',
      'showcase: once claimed, the live status reply points links.help at the showcase topic; the app\'s page ends up at https://embarko.ai/showcase/app/<app-name>',
    ],
    feedback: 'Every reply carries links.feedback. Report anything that fails or is confusing, with a type saying what kind of problem it was.',
    feedback_types: {
      platform_bug: 'Embarko itself misbehaved',
      missing_capability: 'the app needs something Embarko does not have',
      docs_issue: 'the docs were wrong or unclear',
      unexpected_behavior: 'it worked, but not as documented',
      other: 'anything else',
    },
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
      'WebSockets are not supported at all (see not_supported above), with or without scale-to-zero.',
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
    // Distinct from rename_app above, and the distinction matters: that
    // one changes the DISPLAY name and leaves the URL alone, this one
    // changes the URL itself. New hostname, new certificate, and the old
    // address stops working with no redirect, so anything linking to it
    // breaks and the freed name can be claimed by someone else. One
    // change per week per app, shared between both surfaces.
    change_app_address: { status: 'available', via: ['agent', 'dashboard'] },
    memory_config: { status: 'available', via: ['dashboard'] },
    // Irreversible with no backup. Agent path requires the caller to
    // resend the app's own name as confirmation — a deploy token alone
    // (requestable by email, no further verification) isn't enough.
    delete_app: { status: 'available', via: ['agent', 'dashboard'] },
    analytics: { status: 'available', via: ['agent', 'dashboard'] },
    secrets: { status: 'unavailable' },
    websockets: { status: 'unavailable' },
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

// ---------------------------------------------------------------------------
// Topics — the same contract, one question at a time.
//
// GET /capabilities is a contents page: one line per topic, saying what it
// covers and where to read it. GET /capabilities/<topic> answers that one
// question completely, so an agent asked "can you add my domain?" reads
// custom-domain and nothing else. The full document above moved to
// GET /capabilities/all.
//
// Every topic has the same shape as the deploy replies (deploy-response.js):
// what it is, whether it's available and to whom, the steps, the limits,
// one `next`, and every URL under `links`. Limits and flags are read from
// the blocks above rather than restated, so a topic can't drift from the
// full document. Order is the order of the deploy journey: deploy, then
// keeping the app, then extras, then what won't work.
// ---------------------------------------------------------------------------

const { IMAGE_RETAIN_COUNT } = require('./image-retention');

const SHIP = 'https://ship.embarko.ai';
const AGENT_API = `${SHIP}/api/apps/<app-name>`;
const DOCS = 'https://embarko.ai/docs';
const topicUrl = (t) => `${SHIP}/capabilities/${t}`;
const via = (feature) => (CAPABILITIES.features[feature] || {}).via || [];
const L = CAPABILITIES.limits;

// Plain-words detail for each feature `features` marks unavailable. Ones
// already covered by not_supported (websockets, scheduled_jobs = cron) are
// left out so nothing is listed twice; a feature missing from here is
// simply not shown, rather than shown without explanation.
const UNAVAILABLE_DETAIL = {
  background_workers: 'No background workers or queues: no work that outlives the request that started it.',
  managed_database: 'No managed database service. Use SQLite under DATA_DIR (see files).',
  backups: 'No backups of an app\'s data.',
  secrets: 'No separate managed secrets store. Env vars are the place for secrets (see env-vars).',
};

const TOPICS = [
  {
    topic: 'deploy',
    covers: 'Uploading an app, what it needs to run here, and waiting for it to go live',
    available: true,
    who: via('deploy'),
    summary: 'Upload an app\'s source and Embarko builds and runs it at <app-name>.embarko.app. No Dockerfile and no account are needed for the first deploy.',
    how: [
      'POST links.deploy with the app\'s source as a tar.gz in the "source" form field (or as JSON: {"appName", "files": [{"path", "content"}]}), and the header X-App-Name.',
      'Optional headers: Authorization: Bearer <token> (without it the app is temporary, see links.claim), X-App-Version, X-App-Type, X-Agent-Name.',
      'A server app replies 202 with status "building": follow its next and poll links.status until status is "live". A static site usually replies 200 with status "live" already.',
    ],
    requirements: [
      `The app reads its port from ${CAPABILITIES.runtime.port_env} and binds ${CAPABILITIES.runtime.bind_address}.`,
      'No Dockerfile. The language is detected from the source: ' + CAPABILITIES.runtime.detects.join(', ') + '.',
      'The manifest (package.json, requirements.txt, ...) or index.html sits at the top of the upload. One upload is one app.',
      'Anything that must survive a redeploy is written under DATA_DIR (see links.files).',
    ],
    limits: [
      `App name: ${L.app_name_pattern}, ${L.app_name_min_length}-${L.app_name_max_length} characters, unique across Embarko. Some names are reserved, e.g. ${L.app_name_reserved_examples.join(', ')}.`,
      `Memory: ${L.memory_mb_default}MB per app.`,
      'JSON uploads: at most 25MB and 2000 files. Use a tar.gz for anything bigger.',
    ],
    next: 'Check the requirements, then POST links.deploy. If the app needs WebSockets, cron or background workers, read links.notSupported first.',
    links: {
      deploy: `${SHIP}/apps`,
      claim: topicUrl('claim'),
      files: topicUrl('files'),
      notSupported: topicUrl('not-supported'),
      docs: `${DOCS}/agent-quickstart`,
    },
  },
  {
    topic: 'static-sites',
    covers: 'Plain websites: published in seconds, with no logs, env vars or memory setting',
    available: true,
    who: via('deploy'),
    summary: 'An upload that is just files (an index.html and assets, a public/ folder, or a Staticfile) is published directly, with no build and no server. It is usually live within a couple of seconds.',
    how: [
      'Deploy it like any other app. The request waits for the publish (up to 5 seconds), so the reply is normally 200 with app.kind "static" and status "live", and next is the claim (or showcase) step.',
      'A very large site that takes longer replies 202 with status "publishing": check its links.status every 2 seconds until it reads "live".',
    ],
    limits: [
      'No app logs: nothing runs on the server.',
      `No env vars and no memory setting: writes are refused with 409 ${CAPABILITIES.static_apps.refused_code}. Put configuration in the files instead.`,
      'No DATA_DIR and no scale-to-zero.',
      'A server app can be redeployed as a static site, but a static site can\'t become a server app (422 app_kind_changed). Use a new app name.',
      'A single-page app that needs a build step (Vite, Create React App) is built and run as a server app instead.',
    ],
    next: 'Deploy it with POST links.deploy. If the site needs server code or secrets, deploy it as a server app instead.',
    links: { deploy: `${SHIP}/apps`, docs: `${DOCS}/capabilities#static-sites` },
  },
  {
    topic: 'claim',
    covers: 'Temporary apps, the 24-hour deletion, and getting a deploy token to keep them',
    available: true,
    who: ['agent', 'dashboard'],
    needsHuman: 'The user reads the token from their email and pastes it back.',
    summary: `An app deployed without a token is live but temporary: it is deleted ${CAPABILITIES.anonymous_deploy.expires_after_hours} hours after it was first deployed unless claimed. The exact time is app.expiresAt in the status reply. Claiming makes it permanent at the same URL.`,
    how: [
      `Check for a token first: the ${CAPABILITIES.credentials.env_var} environment variable, then ${CAPABILITIES.credentials.file}. If one exists, just redeploy the same app name with it.`,
      'Otherwise ask the user for their email and POST {"email": "<their email>"} to links.requestToken. It always answers 202; the token is emailed, never returned. An account is created if they don\'t have one.',
      `Ask the user to paste the token back. Save it to ${CAPABILITIES.credentials.file} so you never ask again.`,
      'Redeploy with the same X-App-Name and the header Authorization: Bearer <token>. The reply says the app is now permanent.',
      'From then on send the same Authorization header on links.status and links.logs too: once claimed, the app is only visible to its owner, and a bare request gets a 404.',
    ],
    limits: [
      'There is no reminder email: tell the user the deletion time yourself.',
      'Token requests are rate limited: 5 per email per hour.',
      `Tokens don't expire and are scoped to one ${CAPABILITIES.credentials.scoped_to}.`,
      'Never send an empty or made-up token: that is a 401, not a temporary deploy.',
    ],
    next: 'If the app is temporary, tell the user when it will be deleted, then ask for their email to claim it.',
    links: { requestToken: `${SHIP}/api/public/deploy-tokens/request`, dashboard: 'https://embarko.ai/app/tokens', docs: `${DOCS}/capabilities#anonymous` },
  },
  {
    topic: 'files',
    covers: 'Where to keep data: DATA_DIR, SQLite, and what survives a redeploy',
    available: true,
    who: ['agent'],
    summary: `Each server app gets a folder at the ${CAPABILITIES.persistence.data_dir_env} environment variable. It survives redeploys and restarts. Everything else on disk is wiped on every redeploy.`,
    how: [
      `Write anything that must last under path.join(process.env.${CAPABILITIES.persistence.data_dir_env}, ...), creating subfolders on startup.`,
      `For a database use SQLite (better-sqlite3) with its file under ${CAPABILITIES.persistence.data_dir_env}, including the -wal and -shm files.`,
    ],
    limits: [
      `Kept on one machine: it does not survive losing that machine (survives_node_loss: ${CAPABILITIES.persistence.survives_node_loss}).`,
      `No backups (backups: ${CAPABILITIES.persistence.backups}).`,
      'No managed database, and no file storage beyond DATA_DIR.',
      'window.storage (from Claude Artifacts) is rejected at deploy time. Use SQLite instead.',
      'Static sites have no DATA_DIR.',
    ],
    next: 'Keep the app\'s data under DATA_DIR, and tell the user it is not backed up.',
    links: { docs: `${DOCS}/capabilities#database` },
  },
  {
    topic: 'env-vars',
    covers: 'Setting secrets and config for a server app, and applying them',
    available: true,
    who: via('env_vars'),
    summary: 'Environment variables for one app, set with its deploy token. Values are write-only: you can list the keys but never read a value back.',
    how: [
      'GET links.list shows which keys are set.',
      'PUT links.setOne with {"value": "...", "apply": true} sets one key and applies it straight away. PUT links.list with {"vars": [{"key", "value"}], "apply": true} sets several (a merge).',
      'Without "apply": true, a write only stores the value: POST links.apply (or redeploy) to make the running app see it.',
    ],
    limits: [
      'Keys match ^[A-Za-z_][A-Za-z0-9_]*$.',
      `Static sites have no env vars: writes are refused with 409 ${CAPABILITIES.static_apps.refused_code}.`,
      'Needs the app\'s deploy token, so the app must be claimed.',
    ],
    next: 'Set the variable with "apply": true, then check the app. If you need a value you don\'t have, ask the user.',
    links: {
      list: `${AGENT_API}/env-vars`,
      setOne: `${AGENT_API}/env-vars/<KEY>`,
      apply: `${AGENT_API}/env-vars/apply`,
      claim: topicUrl('claim'),
      docs: `${DOCS}/api#env-vars`,
    },
  },
  {
    topic: 'custom-domain',
    covers: 'Using your own domain for an app, including the DNS step a person has to do',
    available: true,
    who: via('custom_domains'),
    needsHuman: 'Creating the DNS record with whoever manages the domain.',
    summary: 'Point a domain or subdomain you own at an Embarko app. HTTPS is set up automatically once DNS is in place.',
    how: [
      'POST links.register with {"domain": "app.example.com"}. The reply gives the exact DNS record to create (a CNAME for a subdomain, an A record for a root domain).',
      'Give that record to the user to create with their DNS provider. You can\'t create it yourself.',
      'Once it has propagated, POST links.verify. It activates the domain, or says DNS isn\'t pointing here yet; retry later.',
      'GET links.register lists the app\'s domains; DELETE links.remove takes one off.',
    ],
    limits: [
      'Needs the app\'s deploy token, so the app must be claimed first.',
      'Embarko\'s own addresses, such as <name>.embarko.app, can\'t be registered (400 domain_reserved).',
      'A domain can belong to only one app (409 domain_taken).',
      'Works for server apps and static sites.',
    ],
    next: 'If the app is temporary, claim it first (links.claim). Then POST links.register with the domain.',
    links: {
      register: `${AGENT_API}/domains`,
      verify: `${AGENT_API}/domains/<domain>/verify`,
      remove: `${AGENT_API}/domains/<domain>`,
      claim: topicUrl('claim'),
      docs: `${DOCS}/capabilities#custom-domains`,
    },
  },
  {
    topic: 'logs',
    covers: 'Reading an app\'s build and runtime logs',
    available: true,
    who: via('logs'),
    summary: 'The recent tail of a server app\'s output. If the latest build failed, you get that build\'s log instead, which is where the failing command is named.',
    how: [
      'GET links.logs; add ?stream=stderr for errors and crashes.',
      'A failed deploy\'s status reply already links to the right logs.',
    ],
    limits: [
      'A snapshot, not a live stream: call it again to follow along.',
      'About the last 8KB, with no long-term retention.',
      'Static sites have no logs.',
      'No token needed while the app is temporary; the app\'s token once claimed.',
    ],
    next: 'GET links.logs with ?stream=stderr, fix what it names, and redeploy.',
    links: { logs: `${SHIP}/apps/<app-name>/logs`, docs: `${DOCS}/api#logs` },
  },
  {
    topic: 'rollback',
    covers: 'Putting an earlier version back, without a rebuild',
    available: true,
    who: via('rollback'),
    summary: 'Switch the app back to a previous successful deploy. No rebuild and no upload; the app keeps its current env vars and domains.',
    how: [
      'GET links.history lists deploys, newest first. rollbackTarget: true marks the ones you can go back to.',
      'POST links.rollback with {} for the previous version, or {"deploymentId": "..."} for a specific one.',
      'The reply is 202: poll its statusUrl until terminal is true.',
    ],
    limits: [
      `Only the last ${IMAGE_RETAIN_COUNT} builds are kept, so rollback reaches back that far.`,
      'Needs the app\'s deploy token.',
    ],
    next: 'Roll back when the app is down and the cause isn\'t clear yet, then fix the code and redeploy.',
    links: { history: `${AGENT_API}/deployments`, rollback: `${AGENT_API}/rollback`, docs: `${DOCS}/api#rollback` },
  },
  {
    topic: 'scale-to-zero',
    covers: 'Letting an idle server app sleep, and the cold start when it wakes',
    available: CAPABILITIES.scale_to_zero.supported,
    who: via('scale_to_zero'),
    summary: `A server app that gets no traffic for ${CAPABILITIES.scale_to_zero.idle_threshold_minutes} minutes can be put to sleep. The first request wakes it, which takes about ${CAPABILITIES.scale_to_zero.typical_cold_start_seconds} seconds. By default apps stay on.`,
    how: [`Send the header ${CAPABILITIES.scale_to_zero.opt_in_header} on POST /apps to opt in, or "false" to opt out.`],
    requirements: CAPABILITIES.scale_to_zero.requirements,
    limits: [...CAPABILITIES.scale_to_zero.notes, 'Not used for static sites.'],
    next: 'Only opt in if a few seconds\' delay on the first request is fine for this app.',
    links: { docs: `${DOCS}/capabilities` },
  },
  {
    topic: "showcase",
    covers: "Show an app on Embarko Showcase or an event Showcase page.",
    available: true,
    who: ["agent"],
    needsHuman: "User confirms the listing before it is published or changed, unless they already asked for it and supplied the details (see flow).",
    summary: "Showcase is a public gallery of apps built with AI agents. Each app has one listing reused across the public and event pages.",
    pages: {
      public: "PUT /showcase without collectionSlug → publishes immediately.",
      event: "PUT /showcase with collectionSlug → requires organiser approval unless a valid code is provided."
    },
    flow: [
      "Only act when the user wants Showcase.",
      "App must be claimed; otherwise follow links.claim first. The deploy token that claimed it is the one to send here.",
      "GET links.existing first (no auth; 404 means not listed yet). Reuse current details and send only changes.",
      "If new, draft accurate listing details from the app/codebase, including customHtml if the app needs more than the description can hold. Ask only for unknown information.",
      "Then ask the user once for the optional fields only they can supply: creatorProfile, contributorEmails (its own question: who built the app, the person showcasing it first), builtWith, videoUrl, screenshotUrls, customHtml (ask if they have custom HTML/formatting to include), and the event slug and code if it is for an event.",
      "Never invent creator details, links, screenshots, event slug, or code.",
      "Show the user the drafted listing and get their go-ahead before the PUT. Prior consent counts: if the user already said to list it and gave the details in this conversation, send it and show them what went live instead of asking again.",
      "A valid event code skips organiser approval and publishes immediately.",
      "Without a code, event listing stays pending until the organiser approves.",
    ],
    auth: "If an Embarko connector tool is listed but not authorized, do not stop: call this endpoint over HTTP with the deploy token, and tell the user to authorize the connector so next time it is one tool call.",
    request: {
      intent: "This is a user-built app showcased on Embarko. Create the page to maximize discoverability and help the creator promote the app. Write clear, accurate, SEO-friendly content based on what the app actually does, who it is for, and the problem it solves.",
      endpoint: `PUT ${AGENT_API}/showcase`,
      headers: {
        Authorization: "Bearer <deploy token>",
        "Content-Type": "application/json"
      },
      body: {
        collectionSlug: "<showcase-page-slug>",   // omit for the public Showcase page
        code: "<submit-code>",                     // optional — page's submit code from the organiser; skips approval
        name: "<display name>",                    // optional — defaults to the app's current name; display only (page title, dashboard label); slug and subdomain stay the same, rename the app itself with PATCH /api/apps/<app-name>
        tagline: "<one line>",                     // required on first submit — meta description; what it does + who it's for, ~60–160 chars
        creatorName: "<name of the person or organization that built the app>",               // required on first submit — shown as the author
        description: "<what it does>",             // page body; plain searchable words, features and use cases, up to 4000 chars
        story: "<why they built it>",              // the problem it solves, in their words, up to 600 chars
        creatorProfile: "<https-profile-url>",     // links the author; e.g. GitHub, X, LinkedIn or personal site
        contributorEmails: ["<email>", "<email>"], // opt-in — everyone who built the app; the FIRST is the person showcasing it and the main contact. "Contact Dev" mails all of them. Ask as its own question, the token email is not consent
        builtWith: "<tool used to build the app>", // e.g. Claude, Codex, Cursor, Lovable, Replit, or another tool
        category: "<closest category>",            // e.g. AI Tool, Personal, Business, Productivity, Education, Game, Developer Tool
        tags: ["<search-term>", "<search-term>"],  // max 8 — lowercase slugs people would search for, not the category again; normalized to "landing-page" form
        screenshotUrls: ["<https-image-url>"],      // max 10 — first is the card/social-share image; real screenshot, not a logo
        videoUrl: "<https-video-url>",              // demo video; e.g. YouTube or Loom
        customHtml: "<plain HTML>"                  // optional extra content below the details, up to 50k; sections, headings, lists, https images only; no script/style/forms/iframes
      }
    },
    merge: "Only supplied fields change. Empty string clears a field; empty arrays clear arrays. Safe to retry.",
    responses: {
      approved: "Live on the page. Give the user links.appPage for this app.",
      pending: "Event organiser must approve; it appears once they do. Resend with the event's code to skip the wait.",
      rejected: "The organiser turned it down; next carries the reason. Fix that and send again.",
    },
    next: {
      noVideo: "App is publicly discoverable. Help the user promote it with platform-specific posts focused on what they built, who it helps, and why people should try it. Suggest adding a short demo video to make the app easier to understand; qualifying approved videos get 1 year of Embarko Pro for this project. For Instagram, suggest tagging @Embarko and inviting @Embarko as collaborator for possible additional reach.",
      videoAdded: "App is publicly discoverable with a demo video. Help the user promote it with platform-specific posts focused on what they built, who it helps, and why people should try it. For Instagram, suggest tagging @Embarko and inviting @Embarko as collaborator for possible additional reach."
    },

    links: {
      existing: `${SHIP}/api/public/showcase/apps/<app-name>`,
      submit: `${AGENT_API}/showcase`,
      showcase: "https://embarko.ai/showcase",
      event: "https://embarko.ai/showcase/<collectionSlug>",
      appPage: "https://embarko.ai/showcase/app/<app-name>",
      claim: topicUrl('claim'),
    }
  },
  {
    topic: 'feedback',
    covers: 'Reporting a bug, a missing feature or a docs problem to the Embarko team',
    available: true,
    who: via('feedback'),
    summary: 'Tell the Embarko team when something fails, is missing, or the docs are wrong. Every deploy reply links here as links.feedback.',
    how: [
      'For an app: POST links.app with the header X-Agent-Name and {"type", "message"}. No token needed while the app is temporary.',
      'Without an app: POST links.public with {"type", "message", "email"}.',
    ],
    types: CAPABILITIES.deploy_flow.feedback_types,
    limits: ['message is 1-5000 characters.', 'The public route is rate limited per email and per IP.'],
    next: 'When something doesn\'t work as documented, report it with the right type rather than working around it silently.',
    links: { app: `${SHIP}/apps/<app-name>/customer-query`, public: `${SHIP}/api/public/customer-query` },
  },
  {
    topic: 'not-supported',
    covers: 'What won\'t work here: WebSockets, cron jobs, background workers and more',
    available: false,
    summary: 'Apps that depend on these deploy fine but the feature fails at runtime, so check before you build.',
    items: [
      ...CAPABILITIES.not_supported.map((n) => ({ feature: n.feature, detail: n.detail, instead: n.use_instead })),
      ...Object.entries(CAPABILITIES.features)
        .filter(([k, v]) => v.status === 'unavailable' && UNAVAILABLE_DETAIL[k])
        .map(([k]) => ({ feature: k, detail: UNAVAILABLE_DETAIL[k] })),
    ],
    next: 'If the app needs any of these, tell the user before deploying rather than after it fails.',
    links: { docs: `${DOCS}/capabilities#summary` },
  },
];

// Other names an agent might reasonably try.
const TOPIC_ALIASES = {
  domain: 'custom-domain', domains: 'custom-domain', 'custom-domains': 'custom-domain', custom_domains: 'custom-domain',
  static: 'static-sites', 'static-site': 'static-sites',
  database: 'files', db: 'files', storage: 'files', persistence: 'files', 'data-dir': 'files', sqlite: 'files',
  'env-var': 'env-vars', env_vars: 'env-vars', secrets: 'env-vars', env: 'env-vars',
  token: 'claim', tokens: 'claim', anonymous: 'claim', orphan: 'claim',
  'scale_to_zero': 'scale-to-zero', sleep: 'scale-to-zero',
  listing: 'showcase', gallery: 'showcase', publish: 'showcase', 'list-app': 'showcase', promote: 'showcase',
  websockets: 'not-supported', cron: 'not-supported', limitations: 'not-supported', unsupported: 'not-supported',
};

function resolveTopic(name) {
  const key = String(name || '').trim().toLowerCase();
  return TOPICS.find((t) => t.topic === key) || TOPICS.find((t) => t.topic === TOPIC_ALIASES[key]) || null;
}

const CONTENTS = {
  version: CAPABILITIES.capabilities_version,
  about: 'What Embarko can and can\'t do. Open the topic you need; each one answers fully on its own.',
  topics: TOPICS.map((t) => ({ topic: t.topic, covers: t.covers, url: topicUrl(t.topic) })),
  links: { all: `${SHIP}/capabilities/all`, docs: `${DOCS}/capabilities` },
};

// Computed once at load: every document here is a constant, so each ETag is too.
const etagOf = (body) => `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
const asServed = (obj) => { const body = JSON.stringify(obj); return { body, etag: etagOf(body) }; };

const CAPABILITIES_BODY = JSON.stringify(CAPABILITIES);
const CAPABILITIES_ETAG = etagOf(CAPABILITIES_BODY);
const CONTENTS_SERVED = asServed(CONTENTS);
const TOPICS_SERVED = Object.fromEntries(
  // Every topic also carries the public feedback link, as every deploy
  // reply does: it works without an app or a token.
  TOPICS.map((t) => [t.topic, asServed({
    version: CAPABILITIES.capabilities_version,
    ...t,
    links: t.topic === 'feedback' ? t.links : { ...t.links, feedback: `${SHIP}/api/public/customer-query` },
  })])
);

module.exports = {
  CAPABILITIES, CAPABILITIES_BODY, CAPABILITIES_ETAG,
  TOPICS, CONTENTS, CONTENTS_SERVED, TOPICS_SERVED, resolveTopic, topicUrl,
};
