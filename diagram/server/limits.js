// Failed-token counter. @fastify/rate-limit counts every request, so this small fixed-window
// limiter counts only the failures and only the failures lock the client out.
export function createAttemptLimiter({ max, windowMs = 60000 }) {
  const attempts = new Map();
  const windowEnd = (entry) => entry.until;

  return {
    blocked(ip) {
      const entry = attempts.get(ip);
      if (!entry) return false;
      if (windowEnd(entry) <= Date.now()) {
        attempts.delete(ip);
        return false;
      }
      return entry.count >= max;
    },
    fail(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || windowEnd(entry) <= now) attempts.set(ip, { count: 1, until: now + windowMs });
      else entry.count += 1;
    },
  };
}
