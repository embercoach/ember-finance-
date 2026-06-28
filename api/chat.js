// Vercel Hobby plan kills functions at 10s — we set this explicitly
// and abort the upstream call at 9s so we always return something first.
export const config = {
  maxDuration: 10,
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Fail fast and loud if the API key isn't configured in this environment
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in this environment');
    return res.status(500).json({
      error: 'The AI service is not configured. Please try again later.',
    });
  }

  // Validate the request body before calling the API
  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages were provided.' });
  }

  // Abort the Anthropic call at 9s so the function can return a clean
  // error before Vercel's 10s limit force-kills it (which causes the hang).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        messages,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json();

    // Surface real API errors instead of passing them back as a "200 OK"
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data);
      return res.status(response.status).json({
        error: data?.error?.message || 'The AI service returned an error.',
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    clearTimeout(timeout);

    if (error.name === 'AbortError') {
      console.error('Anthropic request timed out (>9s)');
      return res.status(504).json({
        error: 'The request took too long. Please try again in a moment.',
      });
    }

    console.error('Handler error:', error);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
    });
  }
}
