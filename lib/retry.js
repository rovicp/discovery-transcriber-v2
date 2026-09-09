// Generic retry wrapper for Google API calls.
// Google APIs occasionally return transient errors (503, "service unavailable",
// rate limits) that succeed on retry. This wraps any async function with
// exponential backoff: 3s, 6s, 12s, 24s, 48s — 5 attempts total.

function isRetriableGoogleError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || (err.response && err.response.status);
  return (
    code === 503 || code === 500 || code === 429 ||
    msg.includes('service is currently unavailable') ||
    msg.includes('unavailable') ||
    msg.includes('internal error') ||
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('backend error') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

async function withRetry(fn, label = 'Google API call') {
  const delays = [3000, 6000, 12000, 24000, 48000];

  for (let i = 0; i < 5; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetriableGoogleError(err) || i === 4) throw err;
      console.log(`${label} transient error (attempt ${i + 1}/5): ${err.message} — retrying in ${delays[i] / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delays[i]));
    }
  }
}

module.exports = { withRetry, isRetriableGoogleError };
