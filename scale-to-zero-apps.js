/**
 * The mode switch, and the exclusions universal mode can never override.
 * Frozen on purpose: widening the exclusions is a reviewed code change.
 * See docs/scale-to-zero-gated-plan.md.
 */

// 'universal' makes every running app eligible except the exclusions below.
// 'allowlist' limits it to apps that opted in via X-Scale-To-Zero: true.
const SCALE_TO_ZERO_MODE = process.env.SCALE_TO_ZERO_MODE === 'universal' ? 'universal' : 'allowlist';

// Never eligible, any mode.
//
// WebSocket apps MUST be added here by hand. Traefik logs a WebSocket
// request only when the connection closes, so a live one is invisible to
// idle detection and the app reads as idle while users are connected.
// Automatic detection via HTTP 101 was tried and removed: across 250k
// logged requests Traefik never recorded a 101, so the check could not
// fire. WebSockets are not a supported capability (see capabilities.js);
// this list is the only protection.
const EXCLUDED_APPS = Object.freeze(['traefik', 'boy-and-dog-server']);

module.exports = {
  SCALE_TO_ZERO_MODE,
  EXCLUDED_APPS,
};
