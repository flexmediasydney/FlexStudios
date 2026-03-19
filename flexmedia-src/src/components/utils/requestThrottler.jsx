// Global request throttler to prevent rate limiting
// Queues and stagger requests intelligently

class RequestThrottler {
  constructor() {
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = 3; // Reduced to prevent rate limiting
    this.minInterval = 150; // Increased interval between requests
    this.lastRequestTime = 0;
    this.backoffMultiplier = 1;
    this.requestTimeout = 30000; // 30s timeout per request (Fix #5)
    this.networkState = 'online'; // Track online/offline (Fix #16)
    this.successCount = 0; // Track success for adaptive scaling (Fix #4)
    window.addEventListener('online', () => this.networkState = 'online');
    window.addEventListener('offline', () => this.networkState = 'offline');
  }

  async execute(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36); // For debugging (Fix #1)
      const timeout = setTimeout(() => {
        // Remove from queue if still pending (Fix #5)
        this.queue = this.queue.filter(req => req.id !== requestId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      this.queue.push({ id: requestId, fn, resolve, reject, priority, timeout });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0 || this.networkState === 'offline') {
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minInterval) {
      setTimeout(() => this.processQueue(), this.minInterval - timeSinceLastRequest);
      return;
    }

    const { id, fn, resolve, reject, timeout } = this.queue.shift();
    this.activeRequests += 1;
    this.lastRequestTime = Date.now();

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), this.requestTimeout)
        )
      ]);
      clearTimeout(timeout);
      this.backoffMultiplier = Math.max(this.backoffMultiplier * 0.9, 1); // Gradual recovery (Fix #4)
      this.successCount += 1;
      // Adaptive scaling: increase concurrency on sustained success (Fix #3)
      if (this.successCount > 30 && this.maxConcurrent < 5) {
        this.maxConcurrent += 1;
        this.successCount = 0;
      }
      resolve(result);
    } catch (error) {
      clearTimeout(timeout);
      const errMsg = (error?.message || '').toLowerCase();
      const isRetryable =
        errMsg.includes('rate limit') ||      // Base44-era pattern
        errMsg.includes('too many requests') || // Supabase 429 pattern
        errMsg.includes('timeout') ||
        errMsg.includes('failed to fetch') ||  // browser offline / DNS
        errMsg.includes('load failed') ||      // Safari fetch failure
        (error?.status === 429) ||             // HTTP 429 from Supabase
        (error?.code === 'PGRST301');          // PostgREST connection limit
      if (isRetryable) {
        this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 8);
        this.minInterval = Math.min(150 * this.backoffMultiplier, 1000);
        this.maxConcurrent = Math.max(this.maxConcurrent - 1, 1); // Reduce concurrency on errors (Fix #3)
        this.successCount = 0;
        // Re-queue on rate limit for retry (Fix #2)
        if (this.queue.length < 50) { // Prevent queue explosion
          this.queue.push({ id, fn, resolve, reject, priority: -1, timeout: null });
          this.queue.sort((a, b) => b.priority - a.priority);
          setTimeout(() => this.processQueue(), 1000 * this.backoffMultiplier);
        } else {
          reject(error);
        }
      } else {
        reject(error);
      }
    } finally {
      this.activeRequests -= 1;
      setTimeout(() => this.processQueue(), 0);
    }
  }

  // Reset state for new page navigation (Fix #4)
  reset() {
    this.backoffMultiplier = 1;
    this.minInterval = 150;
    this.maxConcurrent = 3;
    this.successCount = 0;
  }
}

export const globalThrottler = new RequestThrottler();