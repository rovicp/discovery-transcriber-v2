// Fresh, self-contained Claude client for this app (modeled on the Analyzer's proven
// pattern, but independent — it imports nothing from the Analyzer). Text-only calls
// with exponential-backoff retry on transient/overload errors.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '4000', 10);

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isRetriable(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return err.status === 529 || err.status === 503 || err.status === 429
    || msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('timeout');
}

async function callClaude(prompt, systemPrompt = null) {
  const delays = [5000, 10000, 20000, 40000, 60000];
  for (let i = 0; i < 5; i++) {
    try {
      const params = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] };
      if (systemPrompt) params.system = systemPrompt;
      const resp = await client().messages.create(params);
      return (resp.content[0] && resp.content[0].text) || '';
    } catch (err) {
      if (!isRetriable(err) || i === 4) throw err;
      await sleep(delays[i]);
    }
  }
}

module.exports = { callClaude, MODEL };
