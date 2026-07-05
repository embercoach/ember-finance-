// api/send-bill-reminders.js
// Triggered daily by Vercel Cron (see vercel.json). Emails users whose recurring
// bills are due in exactly 3 days, and marks each one so it's never emailed twice.

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jjftkkpzyzojtxulpfcj.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!SERVICE_KEY || !RESEND_KEY) {
    return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY or RESEND_API_KEY env vars' });
  }

  try {
    const today = new Date();
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + 3);
    const targetStr = targetDate.toISOString().split('T')[0];

    const recRes = await fetch(
      `${SUPABASE_URL}/rest/v1/recurring?active=eq.true&next_date=eq.${targetStr}&select=*`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const dueRules = await recRes.json();

    let sent = 0;
    for (const rule of dueRules || []) {
      if (rule.reminder_sent_for === targetStr) continue;

      const profRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${rule.user_id}&select=email,name`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
      );
      const [profile] = await profRes.json();
      if (!profile?.email) continue;

      const amountStr = Math.abs(rule.amount).toFixed(2);
      const kind = rule.amount < 0 ? 'payment' : 'income';
      const currency = rule.currency || 'USD';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Thrive AI <onboarding@resend.dev>',
          to: profile.email,
          subject: `Reminder: ${rule.name} due in 3 days`,
          html: `<p>Hi ${profile.name || 'there'},</p><p>Just a heads up — your ${kind} "<strong>${rule.name}</strong>" of <strong>${currency} ${amountStr}</strong> is due on <strong>${targetStr}</strong>.</p><p style="color:#888;font-size:12px">This is an automated reminder from Thrive AI. Educational purposes only.</p>`
        })
      });

      await fetch(`${SUPABASE_URL}/rest/v1/recurring?id=eq.${rule.id}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ reminder_sent_for: targetStr })
      });

      sent++;
    }

    res.status(200).json({ ok: true, checked: (dueRules || []).length, sent });
  } catch (err) {
    console.error('Bill reminder error:', err);
    res.status(500).json({ error: err.message });
  }
}
