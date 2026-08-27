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

// ── Email notifications (new lead, new vendor quotation) ──────────────────
// Both fire only on genuinely-new items (never on edits/re-saves of
// something already stored), detected by diffing the incoming payload
// against what was in Redis BEFORE this save. Sent via Resend's REST API
// directly — no SDK dependency, just fetch (available in the Vercel Node
// runtime). Configured entirely through env vars so no secret ever lives in
// source. Both notification types share the same recipient/sender config —
// one Resend setup covers leads and quotations, no extra env vars needed:
//   RESEND_API_KEY    required — from resend.com. If unset, notifications are
//                      silently skipped (logged) so the underlying save
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

// Small fixed lookup so the email shows a real shop name instead of a raw
// id — mirrors the SHOPS list in app.html. Falls back to the id itself for
// any shop added there later without a matching update here.
const SHOP_NAMES = { northpoint: 'Bohai Model' };

function rowsTable(rows) {
  return '<table cellpadding="0" cellspacing="0">' +
    rows.filter(([, v]) => v).map(([k, v]) => (
      '<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap;">' + escapeHtml(k) + '</td>' +
      '<td style="padding:3px 0;">' + escapeHtml(v) + '</td></tr>'
    )).join('') +
    '</table>';
}

async function sendNotificationEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping notification email:', subject);
    return;
  }
  const to = process.env.LEAD_NOTIFY_TO || 'support@physical-model.com';
  const from = process.env.LEAD_NOTIFY_FROM || 'Carve Model <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Resend notification failed:', res.status, text);
    }
  } catch (err) {
    console.error('Resend notification error:', err);
  }
}

async function sendLeadNotification(lead) {
  const c = lead.client || {};
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;">' +
    '<h2 style="margin:0 0 12px;">New lead: ' + escapeHtml(lead.title || 'Untitled project') + '</h2>' +
    rowsTable([
      ['Name', c.Name], ['Company', c.Company], ['Email', c.Email], ['Phone', c.Phone],
      ['Project', lead.title], ['Type', lead.type], ['Intended use', lead.intendedUse],
      ['Scale', lead.scale], ['Model size', lead.modelsize], ['Quantity', lead.quantity],
      ['Timeline', lead.timeline], ['Deliver to', lead.deliveryTo], ['Notes', lead.notes],
    ]) +
    '<p style="margin-top:16px;"><a href="https://www.carvecreation.com/login">Open Studio Portal →</a></p>' +
    '</div>';
  await sendNotificationEmail('New lead: ' + (lead.title || c.Name || 'Untitled project'), html);
}

// entry: { brief, shopId, quote, variationLabel } — variationLabel is set
// only for a variation quote (SRC_addVariation), null for the primary quote
// (SRC_quote).
async function sendQuoteNotification(entry) {
  const { brief, shopId, quote, variationLabel } = entry;
  const shopName = SHOP_NAMES[shopId] || shopId;
  const kind = variationLabel ? ('Variation quote — ' + variationLabel) : 'Quote';
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;">' +
    '<h2 style="margin:0 0 12px;">New ' + escapeHtml(kind.toLowerCase()) + ' from ' + escapeHtml(shopName) + '</h2>' +
    rowsTable([
      ['Project', brief.title], ['Reference', brief.code], ['Shop', shopName],
      ['Price', quote.price != null ? ('$' + quote.price) : null],
      ['Price (RMB)', quote.priceRMB != null ? ('¥' + quote.priceRMB) : null],
      ['Production time', quote.days != null ? (quote.days + ' days') : null],
      ['Category', quote.category], ['Scale', quote.scale], ['Material', quote.material],
      ['Base', quote.base], ['Model dimensions', quote.modelDims],
      ['Packages', quote.packages], ['Note', quote.note],
    ]) +
    '<p style="margin-top:16px;"><a href="https://www.carvecreation.com/login">Open Studio Portal →</a></p>' +
    '</div>';
  await sendNotificationEmail(
    'New quote from ' + shopName + ': ' + (brief.title || brief.id),
    html
  );
}

// Diffs incoming briefs against what was stored before this save and
// returns one entry per genuinely-new quote — a primary quote appearing at
// quotes[shopId] where it wasn't there before, or a variation appended to
// variations[shopId] beyond the previously-stored count. A revise (which
// deletes then re-adds) naturally shows up again as new, which is the
// desired behavior — that's a fresh number worth a notification.
function detectNewQuotes(currentBriefs, incomingBriefs) {
  const currentById = new Map();
  (currentBriefs || []).forEach((b) => { if (b && b.id) currentById.set(b.id, b); });
  const found = [];
  (incomingBriefs || []).forEach((incoming) => {
    if (!incoming || !incoming.id) return;
    const prev = currentById.get(incoming.id);
    const prevQuotes = (prev && prev.quotes) || {};
    const incQuotes = incoming.quotes || {};
    Object.keys(incQuotes).forEach((shopId) => {
      if (incQuotes[shopId] && !prevQuotes[shopId]) {
        found.push({ brief: incoming, shopId, quote: incQuotes[shopId], variationLabel: null });
      }
    });
    const prevVars = (prev && prev.variations) || {};
    const incVars = incoming.variations || {};
    Object.keys(incVars).forEach((shopId) => {
      const prevArr = prevVars[shopId] || [];
      const incArr = incVars[shopId] || [];
      for (let i = prevArr.length; i < incArr.length; i++) {
        if (incArr[i]) found.push({ brief: incoming, shopId, quote: incArr[i], variationLabel: incArr[i].label || 'Variation', variantIndex: i });
      }
    });
  });
  return found;
}

// Guards against sending the same notification twice when two requests for
// the same new lead/quote race each other (e.g. a slow connection causing a
// retry, or two near-simultaneous saves). The "is this new" check above
// reads Redis before writing, so it isn't atomic on its own — two concurrent
// POSTs can both read the pre-save state and both conclude "this is new".
// This claims a dedicated key per notification atomically (SET ... NX): only
// whichever request claims it first actually sends the email; any others
// silently skip. TTL is just storage hygiene — ids are never reused, so it
// doesn't affect correctness.
const NOTIFY_CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;
async function claimNotification(redis, key) {
  try {
    const result = await redis.set(key, '1', { NX: true, EX: NOTIFY_CLAIM_TTL_SECONDS });
    return result === 'OK';
  } catch (err) {
    console.error('claimNotification error for', key, err);
    return true; // fail open — better an occasional duplicate than a silently dropped real notification
  }
}
async function filterClaimed(redis, items, keyFn) {
  const claimed = await Promise.all(items.map((item) => claimNotification(redis, keyFn(item))));
  return items.filter((_, i) => claimed[i]);
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
      const newQuotes = detectNewQuotes(current.briefs, body.briefs);

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
      // key or a transient API error must not stop the save itself. Claim
      // each notification atomically first so a racing duplicate request
      // never sends the same email twice (see claimNotification above).
      const claimedLeads = await filterClaimed(redis, newLeads, (l) => 'carve:notified:lead:' + l.id);
      const claimedQuotes = await filterClaimed(redis, newQuotes, (q) => (
        'carve:notified:quote:' + q.brief.id + ':' + q.shopId + ':' + (q.variationLabel ? ('var:' + q.variantIndex) : 'primary')
      ));
      const notifications = [
        ...claimedLeads.map((l) => sendLeadNotification(l)),
        ...claimedQuotes.map((q) => sendQuoteNotification(q)),
      ];
      if (notifications.length) {
        await Promise.allSettled(notifications);
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
