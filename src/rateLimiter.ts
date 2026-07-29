/**
 * rateLimiter.ts - Sliding window rate limiter
 *
 * Tracks request timestamps per client (identified by MCP session)
 * and rejects requests exceeding the configured rate.
 * Uses a simple in-memory sliding window — sufficient for a single
 * MCP server process with stdio transport.
 */

import { getConfig } from "./config.js";
import { RateLimitError } from "./errors.js";

interface RequestRecord {
  timestamp: number;
}

/** Sliding window rate limiter */
export class RateLimiter {
  private maxPerMinute: number;
  private enabled: boolean;
  /** Map of client key -> array of request timestamps */
  private windows = new Map<string, RequestRecord[]>();
  /** Cleanup interval reference */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    const config = getConfig();
    this.maxPerMinute = config.rateLimit.maxRequestsPerMinute;
    this.enabled = config.rateLimit.enabled;

    // Clean up old entries every minute to prevent memory growth
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if a request from the given client key is allowed.
   * Throws RateLimitError if the limit is exceeded.
   */
  check(clientKey: string = "default"): void {
    if (!this.enabled) return;

    const now = Date.now();
    const windowStart = now - 60_000; // 1 minute ago

    let records = this.windows.get(clientKey) ?? [];
    // Filter out entries older than 1 minute
    records = records.filter((r) => r.timestamp > windowStart);

    if (records.length >= this.maxPerMinute) {
      throw new RateLimitError(this.maxPerMinute);
    }

    records.push({ timestamp: now });
    this.windows.set(clientKey, records);
  }

  /** Remove expired entries to prevent unbounded memory growth */
  private cleanup(): void {
    const cutoff = Date.now() - 60_000;
    for (const [key, records] of this.windows) {
      const filtered = records.filter((r) => r.timestamp > cutoff);
      if (filtered.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, filtered);
      }
    }
  }

  /** Get current usage stats for a client */
  getUsage(clientKey: string = "default"): { count: number; limit: number; remaining: number } {
    const now = Date.now();
    const windowStart = now - 60_000;
    const records = (this.windows.get(clientKey) ?? []).filter(
      (r) => r.timestamp > windowStart
    );
    return {
      count: records.length,
      limit: this.maxPerMinute,
      remaining: Math.max(0, this.maxPerMinute - records.length),
    };
  }

  /** Shutdown — clear the cleanup timer */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}

// Singleton
let instance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!instance) {
    instance = new RateLimiter();
  }
  return instance;
}

/**
 * Middleware-like wrapper for tool handlers.
 * Wraps a tool callback, checking rate limit before execution.
 */
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  clientKey?: string
): T {
  return (async (...args: any[]) => {
    getRateLimiter().check(clientKey);
    return handler(...args);
  }) as T;
}
