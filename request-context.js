/**
 * Carries the current request's unique id to every logger call made while
 * handling it, without threading it through every function argument.
 */
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

function runWithRequestId(requestId, fn) {
  return storage.run({ requestId }, fn);
}

function getRequestId() {
  return storage.getStore()?.requestId;
}

module.exports = { runWithRequestId, getRequestId };
