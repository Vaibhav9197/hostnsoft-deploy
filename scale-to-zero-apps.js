/**
 * The seed allowlist, the mode switch, and the exclusions universal mode
 * can never override. Frozen on purpose: widening it is a reviewed code
 * change. See docs/scale-to-zero-gated-plan.md.
 */

// ALWAYS-FRONT: router priority 500, so the activator sits permanently in
// front and there is no post-stop 502 window. Verified in prod since
// 2026-09-21. Universal apps get priority 1 instead.
const SCALE_TO_ZERO_APPS = Object.freeze([
  'scale-to-zero-test-1',
  'demo-python',
  'pushpendra-agrawal',
  'socket-ux',
]);

// 'universal' makes every running app eligible except the exclusions below.
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

function isAlwaysFront(appName) {
  return SCALE_TO_ZERO_APPS.includes(appName);
}

module.exports = {
  SCALE_TO_ZERO_APPS,
  SCALE_TO_ZERO_MODE,
  EXCLUDED_APPS,
  isAlwaysFront,
};
