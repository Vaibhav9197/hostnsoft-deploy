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
  capabilities_version: '2026-09-15',

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
    survives_node_loss: false,
    backups: false,
  },

  // status: available | preview | unavailable
  // via:    who can actually invoke it today
  features: {
    deploy: { status: 'available', via: ['agent', 'dashboard'] },
    redeploy: { status: 'available', via: ['agent', 'dashboard'] },
    deploy_status: { status: 'available', via: ['agent', 'dashboard'] },
    logs: { status: 'available', via: ['agent', 'dashboard'] },
    feedback: { status: 'available', via: ['agent', 'dashboard'] },
    env_vars: { status: 'available', via: ['dashboard'] },
    rollback: { status: 'available', via: ['dashboard'] },
    custom_domains: { status: 'available', via: ['dashboard'] },
    deployment_history: { status: 'available', via: ['dashboard'] },
    memory_config: { status: 'available', via: ['dashboard'] },
    delete_app: { status: 'available', via: ['dashboard'] },
    analytics: { status: 'available', via: ['dashboard'] },
    secrets: { status: 'unavailable' },
    scheduled_jobs: { status: 'unavailable' },
    background_workers: { status: 'unavailable' },
    managed_database: { status: 'unavailable' },
    backups: { status: 'unavailable' },
  },

  // Only values the code actually enforces. See the header comment.
  limits: {
    memory_mb_default: 256,
    memory_mb_with_embedded_db: 512,
    app_name_pattern: '^[a-z0-9-]+$',
    app_name_scope: 'platform_wide',
    app_version_pattern: '^[a-zA-Z0-9._-]+$',
  },

  // APIs that are rejected at deploy time, before a build is attempted.
  unsupported_apis: [
    {
      api: 'window.storage',
      reason: 'Specific to the Claude Artifacts sandbox; does not exist here.',
      http_status: 422,
      code: 'unsupported_storage_pattern',
      use_instead: ['better-sqlite3', '@electric-sql/pglite'],
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
