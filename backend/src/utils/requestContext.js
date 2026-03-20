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

function getContext() {
  return storage.getStore() || {};
}

function getRequestId() {
  return storage.getStore()?.requestId;
}

function getTenantId() {
  return storage.getStore()?.tenantId;
}

module.exports = { runWithContext, getContext, getRequestId, getTenantId };
