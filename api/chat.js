// Vercel Hobby plan kills functions at 10s — we set this explicitly
// and abort the upstream call at 9s so we always return something first.
export const config = {
  maxDuration: 10,
};

const FREE_AI_LIMIT = 3;

function currentMonthKey() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in this environment');
    return res.status(500).json({
      error: 'The AI service is not configured. Please try again later.',
    });
  }

  const { messages, system, userId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages were provided.' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'Missing user identity.' });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_URL) {
    console.error('Supabase service role env vars are not set');
    return res.status(500).json({
      error: 'The AI service is not configured. Please try again later.',
    });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  let profile;
  try {
    const profileRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_pro,ai_questions_count,ai_questions_month`,
      { headers: supaHeaders }
    );
    const rows = await profileRes.json();
    profile = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('Failed to look up profile for AI limit check:', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  if (!profile) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const isPro = !!profile.is_pro;
  const thisMonth = currentMonthKey();
  let count = profile.ai_questions_month === thisMonth ? (profile.ai_questions_count || 0) : 0;

  if (!isPro && count >= FREE_AI_LIMIT) {
    return res.status(403).json({
      error: `You've used all ${FREE_AI_LIMIT} free questions this month. Your questions reset at the start of next month, or you can upgrade to Pro for unlimited conversations.`,
      limitReached: true,
    });
  }

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

    if (!response.ok) {
      console.error('Anthropic API error:', response.status, data);
      return res.status(response.status).json({
        error: data?.error?.message || 'The AI service returned an error.',
      });
    }

    if (!isPro) {
      count += 1;
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: { ...supaHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ ai_questions_count: count, ai_questions_month: thisMonth }),
        });
      } catch (e) {
        console.error('Failed to update ai_questions_count:', e);
      }
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
