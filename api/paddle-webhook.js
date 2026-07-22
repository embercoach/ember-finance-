// Paddle calls this endpoint whenever a subscription is created, renewed,
// updated, or canceled. We verify the request really came from Paddle,
// then flip is_pro on/off in Supabase accordingly, and store the
// subscription ID so the user can cancel it later from inside the app.

import crypto from 'crypto';

// Disable Vercel's automatic body parsing — we need the RAW body bytes
// to verify Paddle's signature. Parsing it first would break verification.
export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(';').map((p) => p.split('='))
  );
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(h1));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const signatureHeader = req.headers['paddle-signature'];
  const secret = process.env.PADDLE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('PADDLE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!verifySignature(rawBody, signatureHeader, secret)) {
    console.error('Paddle webhook signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    console.error('Failed to parse Paddle webhook body:', e);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event.event_type;
  const data = event.data || {};
  const userId = data.custom_data?.userId;
  const subscriptionId = data.id;

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  async function updateProfile(fields) {
    if (!userId) {
      console.error(`No userId in custom_data for event ${eventType}`, data.id);
      return;
    }
    try {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify(fields),
      });
    } catch (e) {
      console.error(`Failed to update profile for user ${userId}:`, e);
    }
  }

  switch (eventType) {
    case 'subscription.created':
    case 'subscription.activated':
    case 'subscription.resumed':
      await updateProfile({ is_pro: true, paddle_subscription_id: subscriptionId });
      break;

    case 'subscription.updated':
      if (data.status === 'active' || data.status === 'trialing') {
        await updateProfile({ is_pro: true, paddle_subscription_id: subscriptionId });
      } else {
        await updateProfile({ is_pro: false });
      }
      break;

    case 'subscription.canceled':
    case 'subscription.paused':
      await updateProfile({ is_pro: false });
      break;

    default:
      break;
  }

  return res.status(200).json({ received: true });
}
