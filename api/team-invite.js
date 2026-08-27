// Vercel serverless function — creates a real, redeemable invite (stored in
// Redis) and sends the invite email (via Resend) when Carve Admin adds
// someone from Team & Access in the Studio Portal (app.html's "+ Add
// member" modal). Everything else about adding a member (saving them to the
// roster shown in the portal) still happens client-side against
// localStorage — this endpoint's only job is making the emailed link real:
// api/auth.js (action "resolveInvite"/"acceptInvite") is what the /login
// page calls when someone actually clicks it.
//
//   RESEND_API_KEY     required to actually send the email. If unset, the
//                       invite is still created (the token is valid and
//                       could be shared manually) but the response comes
//                       back with emailed:false so the admin knows to follow
//                       up directly.
//   TEAM_INVITE_FROM    sender shown on the email. Falls back to
//                       LEAD_NOTIFY_FROM, then Resend's sandbox sender.

const { createClient } = require('redis');
const crypto = require('crypto');

let clientPromise;
function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis client error:', err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Role key 'sales' is displayed to admins/invitees as "Client Manager" — see
// the matching note in app.html's ROLE_LABELS for why the stored key differs
// from the label.
const ROLE_LABELS = { owner: 'Owner', sales: 'Client Manager', factory: 'Factory Representative' };
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — matches the copy in the email

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const role = String(body.role || '').trim();

    if (!name || !email) {
      res.status(400).json({ error: 'Name and email are required.' });
      return;
    }

    const token = 'inv_' + crypto.randomBytes(12).toString('hex');
    const redis = await getClient();
    await redis.set('carve:invite:' + token, JSON.stringify({ name, email, role }), { EX: INVITE_TTL_SECONDS });

    const origin = req.headers.origin || ('https://' + req.headers.host);
    const link = origin + '/login?invite=' + encodeURIComponent(token);

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('RESEND_API_KEY not set — invite created but no email sent for', email);
      res.status(200).json({ ok: true, emailed: false, reason: 'RESEND_API_KEY not configured' });
      return;
    }

    const roleLabel = ROLE_LABELS[role] || role || 'Team member';
    const from = process.env.TEAM_INVITE_FROM || process.env.LEAD_NOTIFY_FROM || 'Carve Model <onboarding@resend.dev>';
    const html =
      '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;">' +
      '<h2 style="margin:0 0 12px;">You’ve been added to the Carve team</h2>' +
      '<p>Hi ' + escapeHtml(name) + ',</p>' +
      '<p>You’ve been added to the Carve internal team as <b>' + escapeHtml(roleLabel) + '</b>.</p>' +
      '<p><a href="' + link + '">Set your password &amp; open the Carve Studio Portal →</a></p>' +
      '<p style="color:#666;">This link expires in 7 days. If you weren’t expecting this, you can safely ignore this email.</p>' +
      '</div>';

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject: 'You’ve been added to the Carve team', html }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('Resend team-invite failed:', r.status, text);
      // The invite itself is still valid even though the email failed —
      // report emailed:false rather than erroring the whole request out.
      res.status(200).json({ ok: true, emailed: false, error: 'Failed to send invite email.' });
      return;
    }

    res.status(200).json({ ok: true, emailed: true });
  } catch (err) {
    console.error('team-invite API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
