import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTransientError, retryWithBackoff, withTimeout } from '../networkResilience';

// ─── isTransientError ────────────────────────────────────────────────────────

describe('isTransientError', () => {
  it('returns false for null/undefined', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it('returns true for "Failed to fetch" errors', () => {
    expect(isTransientError(new Error('Failed to fetch'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isTransientError(new Error('network error occurred'))).toBe(true);
  });

  it('returns true for timeout errors', () => {
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
  });

  it('returns true for Safari "Load failed" errors', () => {
    expect(isTransientError(new Error('Load failed'))).toBe(true);
  });

  it('returns true for aborted requests', () => {
    expect(isTransientError(new Error('The operation was aborted'))).toBe(true);
  });

  it('returns true for rate limit messages', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransientError(new Error('Too many requests'))).toBe(true);
  });

  it('returns true for 502/503/504 message strings', () => {
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('returns true for status code 429', () => {
    expect(isTransientError({ status: 429, message: '' })).toBe(true);
  });

  it('returns true for status code 502', () => {
    expect(isTransientError({ status: 502, message: '' })).toBe(true);
  });

  it('returns true for status code 503', () => {
    expect(isTransientError({ status: 503, message: '' })).toBe(true);
  });

  it('returns true for status code 504', () => {
    expect(isTransientError({ status: 504, message: '' })).toBe(true);
  });

  it('returns true for statusCode property (alternate field name)', () => {
    expect(isTransientError({ statusCode: 429, message: '' })).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Cannot read property of undefined'))).toBe(false);
    expect(isTransientError(new Error('Validation failed'))).toBe(false);
    expect(isTransientError({ status: 400, message: 'Bad request' })).toBe(false);
    expect(isTransientError({ status: 404, message: 'Not found' })).toBe(false);
  });
});

// ─── retryWithBackoff ────────────────────────────────────────────────────────

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns the result on first success (no retries needed)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately for non-transient errors', async () => {
    const err = new Error('Validation error');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn)).rejects.toThrow('Validation error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    const transientErr = new Error('Failed to fetch');
    const fn = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce('recovered');

    const promise = retryWithBackoff(fn, { maxRetries: 2, baseDelay: 100 });
    // Advance past the first retry delay (100ms * 2^0 = 100ms)
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls onRetry callback on each retry', async () => {
    const transientErr = new Error('network error');
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(fn, { maxRetries: 2, baseDelay: 100, onRetry });
    await vi.advanceTimersByTimeAsync(150);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(transientErr, 1);
  });

  it('throws after exhausting all retries', async () => {
    const transientErr = new Error('Failed to fetch');
    const fn = vi.fn().mockRejectedValue(transientErr);

    const promise = retryWithBackoff(fn, { maxRetries: 2, baseDelay: 50 });
    // Catch early to prevent unhandled rejection during timer advancement
    const resultPromise = promise.catch(e => e);
    // Advance through both retry delays: 50ms, 100ms
    await vi.advanceTimersByTimeAsync(200);
    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Failed to fetch');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('respects custom shouldRetry predicate', async () => {
    const err = new Error('custom retryable');
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(fn, {
      maxRetries: 1,
      baseDelay: 50,
      shouldRetry: (e) => e.message.includes('custom retryable'),
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff delays', async () => {
    const transientErr = new Error('Failed to fetch');
    const fn = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(fn, { maxRetries: 3, baseDelay: 100 });

    // First retry at 100ms (100 * 2^0)
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry at 200ms (100 * 2^1)
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

// ─── withTimeout ─────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('resolves if the promise completes before timeout', async () => {
    const promise = Promise.resolve('done');
    const result = await withTimeout(promise, 5000, 'Test');
    expect(result).toBe('done');
  });

  it('rejects with timeout error if promise exceeds deadline', async () => {
    const slowPromise = new Promise(() => {}); // never resolves
    const wrapped = withTimeout(slowPromise, 1000, 'SlowOp');

    // Catch the rejection before advancing timers to avoid unhandled rejection
    const resultPromise = wrapped.catch(e => e);
    await vi.advanceTimersByTimeAsync(1100);
    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SlowOp timed out after 1s');
  });

  it('includes the label and duration in the error message', async () => {
    const slowPromise = new Promise(() => {});
    const wrapped = withTimeout(slowPromise, 5000, 'DataFetch');

    const resultPromise = wrapped.catch(e => e);
    await vi.advanceTimersByTimeAsync(5100);
    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('DataFetch timed out after 5s');
  });

  it('uses default label and timeout when not provided', async () => {
    const slowPromise = new Promise(() => {});
    const wrapped = withTimeout(slowPromise);

    const resultPromise = wrapped.catch(e => e);
    await vi.advanceTimersByTimeAsync(31000);
    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Operation timed out after 30s');
  });

  it('cleans up the timeout when promise resolves', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const promise = Promise.resolve('quick');
    await withTimeout(promise, 5000);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
