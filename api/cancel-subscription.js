// Called from the app when a logged-in user clicks "Cancel Subscription."
// Verifies the user via their Supabase auth token, looks up their stored
// Paddle subscription ID, and tells Paddle to cancel it at the end of the
// current billing period (they keep Pro access until then).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const userToken = authHeader.replace('Bearer ', '');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 1. Verify the token and get the user's ID
  let userId;
  try {
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${userToken}`,
      },
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const userData = await userResp.json();
    userId = userData.id;
  } catch (e) {
    console.error('Failed to verify user token:', e);
    return res.status(500).json({ error: 'Could not verify session' });
  }

  if (!userId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // 2. Look up their stored Paddle subscription ID
  let subscriptionId;
  try {
    const profileResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=paddle_subscription_id,is_pro`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      }
    );
    const profiles = await profileResp.json();
    subscriptionId = profiles?.[0]?.paddle_subscription_id;

    if (!profiles?.[0]?.is_pro) {
      return res.status(400).json({ error: 'No active Pro subscription found' });
    }
  } catch (e) {
    console.error('Failed to look up profile:', e);
    return res.status(500).json({ error: 'Could not look up subscription' });
  }

  if (!subscriptionId) {
    return res.status(400).json({
      error: 'No subscription on file. Contact support if you believe this is a mistake.',
    });
  }

  // 3. Tell Paddle to cancel at the end of the current billing period
  try {
    const paddleApiBase =
      process.env.PADDLE_ENV === 'production'
        ? 'https://api.paddle.com'
        : 'https://sandbox-api.paddle.com';

    const cancelResp = await fetch(
      `${paddleApiBase}/subscriptions/${subscriptionId}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          effective_from: 'next_billing_period',
        }),
      }
    );

    if (!cancelResp.ok) {
      const errBody = await cancelResp.text();
      console.error('Paddle cancel request failed:', cancelResp.status, errBody);
      return res.status(502).json({ error: 'Paddle could not process the cancellation' });
    }

    // Note: is_pro stays true until Paddle sends the subscription.canceled
    // webhook at the end of the billing period — that's expected and correct.
    return res.status(200).json({
      success: true,
      message: 'Your subscription will remain active until the end of the current billing period.',
    });
  } catch (e) {
    console.error('Error calling Paddle cancel API:', e);
    return res.status(500).json({ error: 'Something went wrong canceling your subscription' });
  }
}
