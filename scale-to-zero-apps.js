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

// Never eligible, any mode. boy-and-dog-server is a WebSocket server: a
// live connection produces no access-log line until it closes, so the app
// reads as idle while users are connected.
const EXCLUDED_APPS = Object.freeze(['traefik', 'boy-and-dog-server']);

// Any app that served an HTTP 101 in this window is treated as a WebSocket
// app and excluded automatically — same reason as above.
const WEBSOCKET_LOOKBACK_DAYS = Number(process.env.WEBSOCKET_LOOKBACK_DAYS) || 7;

function isAlwaysFront(appName) {
  return SCALE_TO_ZERO_APPS.includes(appName);
}

module.exports = {
  SCALE_TO_ZERO_APPS,
  SCALE_TO_ZERO_MODE,
  EXCLUDED_APPS,
  WEBSOCKET_LOOKBACK_DAYS,
  isAlwaysFront,
};
