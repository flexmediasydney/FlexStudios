/**
 * networkResilience.js — Shared utilities for network failure handling.
 *
 * Provides:
 *  1. retryWithBackoff()  — retry transient failures with exponential backoff
 *  2. withTimeout()       — wrap a promise with a deadline
 *  3. useOnlineStatus()   — React hook exposing navigator.onLine + events
 *  4. isTransientError()  — classify errors worth retrying
 */

// ─── Error classification ────────────────────────────────────────────────────

export function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode;
  return (
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('load failed') ||       // Safari
    msg.includes('aborted') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

// ─── Retry with exponential backoff ──────────────────────────────────────────

/**
 * Retry an async function on transient failures.
 *
 * @param {Function} fn          — async function to execute
 * @param {Object}   opts
 * @param {number}   opts.maxRetries   — max retry attempts (default 2)
 * @param {number}   opts.baseDelay    — initial delay in ms (default 1000)
 * @param {Function} opts.shouldRetry  — predicate(err) → boolean (default isTransientError)
 * @param {Function} opts.onRetry      — callback(err, attempt) for logging/toasting
 * @returns {Promise<*>}
 */
export async function retryWithBackoff(fn, {
  maxRetries = 2,
  baseDelay = 1000,
  shouldRetry = isTransientError,
  onRetry = null,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && shouldRetry(err)) {
        if (onRetry) onRetry(err, attempt + 1);
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ─── Timeout wrapper ─────────────────────────────────────────────────────────

/**
 * Wrap a promise with a timeout.
 *
 * @param {Promise} promise
 * @param {number}  ms       — timeout in milliseconds (default 30000)
 * @param {string}  label    — operation name for the error message
 * @returns {Promise<*>}
 */
export function withTimeout(promise, ms = 30000, label = 'Operation') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// ─── React hook: online status ───────────────────────────────────────────────

import { useState, useEffect, useSyncExternalStore } from 'react';

function subscribeOnline(callback) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function getOnlineSnapshot() {
  return navigator.onLine;
}

/**
 * React hook that returns `true` when the browser is online, `false` when offline.
 * Triggers re-render on connectivity change.
 */
export function useOnlineStatus() {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, () => true);
}
