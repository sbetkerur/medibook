'use strict';
/**
 * AsyncLocalStorage-based request context propagation.
 * Threads request ID and user context through async call chains
 * without passing req through every function signature.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithContext(context, fn) {
  return storage.run(context, fn);
}

function getRequestId() {
  return storage.getStore()?.requestId;
}

function getTenantId() {
  return storage.getStore()?.tenantId;
}

// Populate tenantId on the ALREADY-RUNNING context for this request, once
// tenant resolution has happened further down the middleware chain. The
// AsyncLocalStorage store is the same object reference for the lifetime of
// the request (runWithContext wraps the whole chain via next()), so mutating
// it here is visible to everything downstream, including logger.js.
// Previously getTenantId() was dead code — nothing ever called this, so it
// always returned undefined and tenantId never appeared in logs.
function setTenantId(tenantId) {
  const store = storage.getStore();
  if (store) store.tenantId = tenantId;
}

module.exports = { runWithContext, getRequestId, getTenantId, setTenantId };
