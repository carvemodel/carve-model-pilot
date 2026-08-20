// Vercel serverless function — shared read/write store for the Sourcing & Quotes data
// (leads + briefs). Lives on the SAME domain as the site (carvecreation.com), so it is
// reachable for every user regardless of location/network — no separate third-party
// domain to whitelist or get blocked.
//
// Backed by the Redis database connected to this project (env var REDIS_URL, injected
// automatically by Vercel when you connected "carve-sourcing-kv" to this project).

const { createClient } = require('redis');

const KEY = 'carve:sourcing';
let clientPromise;

function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis client error:', err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

// ── New-lead email notification ─────────────────────────────────────────
// Fires once per genuinely-new lead id (never on edits to an existing lead,
// so re-saves from the admin Studio Portal don't re-notify). Sent via
// Resend's REST API directly — no SDK dependency, just fetch (available in
// the Vercel Node runtime). Configured entirely through env vars so no
// secret ever lives in source:
//   RESEND_API_KEY    required — from resend.com. If unset, notification is
//                      silently skipped (logged) so lead submission itself
//                      never fails because of email config.
//   LEAD_NOTIFY_TO     recipient address. Defaults to support@physical-model.com.
//   LEAD_NOTIFY_FROM   sender shown on the email. Must be on a domain
//                      verified in Resend, or sends will fail — defaults to
//                      Resend's own onboarding@resend.dev sandbox sender,
//                      which works with no domain setup but is best swapped
//                      for a carvecreation.com address once that domain is
//                      verified in the Resend dashboard.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function sendLeadNotification(lead) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping new-lead notification email');
    return;
  }
  const to = process.env.LEAD_NOTIFY_TO || 'support@physical-model.com';
  const from = process.env.LEAD_NOTIFY_FROM || 'Carve Model <onboarding@resend.dev>';

  const c = lead.client || {};
  const rows = [
    ['Name', c.Name],
    ['Company', c.Company],
    ['Email', c.Email],
    ['Phone', c.Phone],
    ['Project', lead.title],
    ['Type', lead.type],
    ['Intended use', lead.intendedUse],
    ['Scale', lead.scale],
    ['Model size', lead.modelsize],
    ['Quantity', lead.quantity],
    ['Timeline', lead.timeline],
    ['Deliver to', lead.deliveryTo],
    ['Notes', lead.notes],
  ].filter(([, v]) => v);

  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;">' +
    '<h2 style="margin:0 0 12px;">New lead: ' + escapeHtml(lead.title || 'Untitled project') + '</h2>' +
    '<table cellpadding="0" cellspacing="0">' +
    rows.map(([k, v]) => (
      '<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap;">' + escapeHtml(k) + '</td>' +
      '<td style="padding:3px 0;">' + escapeHtml(v) + '</td></tr>'
    )).join('') +
    '</table>' +
    '<p style="margin-top:16px;"><a href="https://www.carvecreation.com/login">Open Studio Portal →</a></p>' +
    '</div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'New lead: ' + (lead.title || c.Name || 'Untitled project'),
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Resend notification failed:', res.status, text);
    }
  } catch (err) {
    console.error('Resend notification error:', err);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const redis = await getClient();

    if (req.method === 'GET') {
      const raw = await redis.get(KEY);
      const data = raw ? JSON.parse(raw) : { briefs: [], leads: [] };
      if (!data.leads) data.leads = [];
      if (!data.briefs) data.briefs = [];
      res.status(200).json(data);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};

      // Every save used to be a blind overwrite of the whole store with whatever
      // this one browser tab currently had in memory. With more than one tab/
      // session open (an admin plus a client submitting a new lead, two admin
      // tabs, a tab left open a while, etc.), whichever tab saved LAST would
      // silently wipe out anything the other tab knew about that it didn't —
      // e.g. a lead someone else had just submitted. Merge by id instead: keep
      // anything already stored that this save doesn't know about, let incoming
      // items overwrite their own matching id (normal edit), and only actually
      // remove an item if its id is explicitly listed in deletedLeadIds /
      // deletedBriefIds (see deleteLead() in app.html) — absence from the
      // incoming payload alone is never treated as "delete this".
      const raw = await redis.get(KEY);
      const current = raw ? JSON.parse(raw) : { briefs: [], leads: [] };
      if (!current.leads) current.leads = [];
      if (!current.briefs) current.briefs = [];

      // Snapshot which lead ids already existed BEFORE merging, so a
      // notification only fires for ids that are genuinely new — an admin
      // re-saving an existing lead (status change, note edit, etc.) must
      // never re-trigger the email.
      const existingLeadIds = new Set(current.leads.map((l) => l && l.id));
      const newLeads = (body.leads || []).filter((l) => l && l.id && !existingLeadIds.has(l.id));

      function mergeById(currentList, incomingList, deletedIds) {
        const deleted = new Set(deletedIds || []);
        const byId = new Map();
        (currentList || []).forEach((item) => { if (item && item.id) byId.set(item.id, item); });
        (incomingList || []).forEach((item) => { if (item && item.id) byId.set(item.id, item); });
        deleted.forEach((id) => byId.delete(id));
        return Array.from(byId.values());
      }

      const data = {
        briefs: mergeById(current.briefs, body.briefs, body.deletedBriefIds),
        leads: mergeById(current.leads, body.leads, body.deletedLeadIds),
      };
      await redis.set(KEY, JSON.stringify(data));

      // Fire-and-await (but never fail the request over it): a bad Resend
      // key or a transient API error must not stop the lead from saving.
      if (newLeads.length) {
        await Promise.allSettled(newLeads.map(sendLeadNotification));
      }

      res.status(200).json({ ok: true, briefs: data.briefs, leads: data.leads });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sourcing API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
