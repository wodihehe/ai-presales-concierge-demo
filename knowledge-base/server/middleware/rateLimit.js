/**
 * Simple in-memory sliding window rate limiter for login and sensitive endpoints
 */
const attempts = new Map();

export function createRateLimiter({ windowMs = 60_000, maxAttempts = 10, message = '请求过于频繁，请稍后再试' } = {}) {
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const now = Date.now();
    const clientAttempts = attempts.get(ip) || [];
    
    // Filter attempts in window
    const recent = clientAttempts.filter(timestamp => now - timestamp < windowMs);
    
    if (recent.length >= maxAttempts) {
      return res.status(429).json({ error: 'rate_limit_exceeded', message });
    }

    recent.push(now);
    attempts.set(ip, recent);

    // Clean up stale entries every 100 requests
    if (attempts.size > 500) {
      for (const [key, list] of attempts.entries()) {
        const valid = list.filter(t => now - t < windowMs);
        if (valid.length === 0) attempts.delete(key);
        else attempts.set(key, valid);
      }
    }

    next();
  };
}
