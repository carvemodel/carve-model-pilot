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

// ── Real server-side sessions ───────────────────────────────────────────────
// A caller used to be trusted to say who it was — a query string or POST body
// could just claim role=factory&email=... (or, worse, role=owner) and this
// file had no way to know that was false. api/auth.js's "login" action now
// mints a random token and stores {email,role,name} under it server-side
// (carve:session:<token>, same Redis instance/KEY namespace) when someone
// really does sign in. Resolving that token here means the role/email this
// file actually acts on come from a verified record, never from whatever the
// request itself asserts — a vendor changing role=factory to role=owner in
// their own request no longer does anything, because nothing here trusts the
// role field unless a real token backs it up (see effectiveRole below).
async function resolveSession(redis, token) {
  if (!token) return null;
  try {
    const raw = await redis.get('carve:session:' + token);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('resolveSession error:', err);
    return null;
  }
}
// A caller that names a role at all (body.role / query.role) is asserting
// "I am a logged-in app user of this type" — that assertion is only ever
// honored if a real session token backs it up. A caller that names NO role
// at all — e.g. the public contact form's `{leads:[...]}` POST from an
// anonymous site visitor, which has no concept of login — is untouched by
// any of this and keeps working exactly as before.
//
// An earlier version of this treated a role claim with no valid token as
// "an unverified vendor with no matched shop" — safe against a vendor
// forging role=owner, but it ALSO silently caught genuine owner/admin saves
// whose session simply predated this token system, or whose token had
// expired for any other benign reason. Because that fallback still returned
// 200 OK, the save LOOKED successful in the browser while actually being
// silently discarded server-side — which is how a real vendor/team roster
// ended up empty with no error ever shown. Failing a request outright with
// 401 when a claimed role's token doesn't check out is the correct
// behavior for every role, factory included: the caller finds out
// immediately and can re-authenticate, instead of a request that appears to
// succeed while quietly doing less (or nothing) at all.
function verifiedIdentity(claimedRole, session) {
  if (!claimedRole) return { role: null, email: null };
  return { role: session.role, email: session.email };
}

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

// toOverride lets a caller send to someone other than the default admin
// inbox (e.g. sendChangeRequestNotification also notifying the project's
// assigned Client Manager) -- defaults to LEAD_NOTIFY_TO/support@ when
// omitted, same as every existing call site.
async function sendNotificationEmail(subject, html, toOverride) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping notification email:', subject);
    return;
  }
  const to = toOverride || process.env.LEAD_NOTIFY_TO || 'support@physical-model.com';
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

// ── OpenAI Ads server-side Conversions API ─────────────────────────────────
// Complements the client-side oaiq pixel (fired in thank-you.astro): posts
// the same lead_created event directly from the server, so the conversion
// is still recorded even if the visitor's browser blocked the pixel/script
// (ad blockers, Safari ITP, etc.). Uses the lead's own id as the event id --
// the SAME id the browser pixel call passes as event_id -- so OpenAI can
// de-duplicate the two lead_created events for one lead into a single
// counted conversion.
//   OPENAI_ADS_API_KEY  required -- an Ads Conversions API key from the
//                        OpenAI Ads dashboard (NOT a regular OpenAI API
//                        key). Set as a Vercel Production env var only --
//                        never committed to the repo or sent to the
//                        browser. If unset, this is silently skipped
//                        (logged) so the underlying save never fails
//                        because of ads config.
const OPENAI_ADS_PIXEL_ID = '4R4qF8nLNG8BVEeTFwTduh';

async function sendOpenAiConversionEvent(lead) {
  const apiKey = process.env.OPENAI_ADS_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_ADS_API_KEY not set — skipping OpenAI Ads conversion event for lead', lead && lead.id);
    return;
  }
  try {
    const res = await fetch('https://bzr.openai.com/v1/events?pid=' + OPENAI_ADS_PIXEL_ID, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        validate_only: false,
        events: [{
          id: String(lead.id),
          type: 'lead_created',
          timestamp_ms: lead.receivedAtISO ? Date.parse(lead.receivedAtISO) : Date.now(),
          source_url: 'https://www.physical-model.com/thank-you',
          action_source: 'web',
          data: { type: 'customer_action' },
        }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('OpenAI Ads conversion event failed:', res.status, text);
    }
  } catch (err) {
    console.error('OpenAI Ads conversion event error:', err);
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

// entry: { brief, change } — change is one item from brief.pendingChanges
// (see submitProjectInfoChangeRequest in app.html): {field, note,
// requestedBy, requestedAt}. Notifies both the Client Manager assigned to
// this project (brief.assignedManager, if any) and Carve Admin (the same
// LEAD_NOTIFY_TO admin inbox every other studio-wide notification uses) —
// whoever's actually free to act on it, since a project without an
// assigned Client Manager yet still needs SOMEONE to see this.
async function sendChangeRequestNotification(entry) {
  const { brief, change } = entry;
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#111;">' +
    '<h2 style="margin:0 0 12px;">Change requested on "' + escapeHtml(brief.title || brief.id) + '"</h2>' +
    rowsTable([
      ['Project', brief.title], ['Reference', brief.code], ['Field', change.field],
      ['Details', change.note], ['Requested by', change.requestedBy], ['Date', change.requestedAt],
    ]) +
    '<p style="margin-top:16px;"><a href="https://www.carvecreation.com/login">Open Studio Portal →</a></p>' +
    '</div>';
  const subject = 'Change requested on "' + (brief.title || brief.id) + '": ' + (change.field || 'Other');
  const adminTo = process.env.LEAD_NOTIFY_TO || 'support@physical-model.com';
  const recipients = new Set([adminTo]);
  if (brief.assignedManager) recipients.add(brief.assignedManager);
  await Promise.allSettled(
    Array.from(recipients).map((to) => sendNotificationEmail(subject, html, to))
  );
}

// Diffs incoming briefs against what was stored before this save and
// returns one entry per genuinely-new pending change request — an item
// appended to pendingChanges[] whose id wasn't in the previously-stored
// array for that same brief. Requests are always unshift()ed onto the
// front client-side, so comparing ids (rather than "beyond the old
// length") is what correctly identifies the new one regardless of where
// it landed in the array.
function detectNewChangeRequests(currentBriefs, incomingBriefs) {
  const currentById = new Map();
  (currentBriefs || []).forEach((b) => { if (b && b.id) currentById.set(b.id, b); });
  const found = [];
  (incomingBriefs || []).forEach((incoming) => {
    if (!incoming || !incoming.id) return;
    const prev = currentById.get(incoming.id);
    const prevIds = new Set(((prev && prev.pendingChanges) || []).map((c) => c && c.id));
    const incChanges = incoming.pendingChanges || [];
    incChanges.forEach((c) => {
      if (c && c.id && !prevIds.has(c.id)) found.push({ brief: incoming, change: c });
    });
  });
  return found;
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

// ── Vendor-safe data filtering (server-side isolation) ──────────────────────
// A factory (vendor) caller's GET response must never contain another
// vendor's quotes/variations, Carve's internal client contact/pricing
// fields, the vendor/team roster, or leads — vendorSafeBrief() strips a
// brief down to only the fields a vendor is allowed to see, scoped to their
// own shopId's quotes/variations. isBriefRelevantToShop() decides whether a
// brief should be included at all (invited to quote it, already quoted it,
// or was awarded it). filterDataForFactory() ties both together and is the
// single choke point the GET handler below calls for any role=factory
// request — restored here after a merge (dedupe-lead-quote-notifications,
// based on an older main) silently dropped these three definitions while
// leaving the call site intact, which is what caused every factory GET to
// 500 with "filterDataForFactory is not defined".
// A factory-role login used to be resolvable ONLY via the single email on
// its shop's own `vendors` record (one login per shop). Vendor Team & Access
// (app.html) lets a vendor admin add MORE logins scoped to the same shop --
// those live in `vendorTeam` (their own list, {id,shopId,name,email}, never
// mixed into `vendors` itself so the "one designated admin contact per shop"
// data other code already relies on -- vendorCompany(), the Owner's Quotes
// tab admin display, etc. -- keeps meaning exactly what it always meant).
// This resolves an email to a shop checking BOTH: the shop's own vendors
// record first (the primary/designated admin), then vendorTeam (an added
// team member). isPrimary distinguishes the two -- see vendorSafeBrief's
// vendorInvoice redaction below for why that distinction matters.
function resolveFactoryShop(data, email) {
  const emailKey = String(email || '').toLowerCase();
  const vendor = (data.vendors || []).find((v) => v && v.email && v.email.toLowerCase() === emailKey);
  if (vendor) return { shopId: vendor.id, isPrimary: true, vendor, memberId: null };
  const member = (data.vendorTeam || []).find((t) => t && t.email && t.email.toLowerCase() === emailKey);
  if (member) {
    const vendorRec = (data.vendors || []).find((v) => v && v.id === member.shopId) || null;
    return { shopId: member.shopId, isPrimary: false, vendor: vendorRec, memberId: member.id };
  }
  return { shopId: null, isPrimary: false, vendor: null, memberId: null };
}
function vendorSafeBrief(b, shopId, team, isPrimary) {
  const quotes = {};
  if (b.quotes && b.quotes[shopId]) quotes[shopId] = b.quotes[shopId];
  const variations = {};
  if (b.variations && b.variations[shopId]) variations[shopId] = b.variations[shopId];
  // The vendor side never gets the full team roster (team: [] below, same
  // as always -- names/emails of every Carve staffer isn't theirs to see),
  // but they should still be able to see WHO their own point of contact is
  // ("Carve Lead" on Project information). Resolve just that one name here,
  // server-side, from the full roster this function still has access to
  // before filterDataForFactory strips it -- the client falls back to this
  // precomputed field when its own local team list is empty (a factory
  // session's, always).
  const managerEmail = String(b.assignedManager || '').toLowerCase();
  const manager = managerEmail ? (team || []).find((t) => t && t.email && t.email.toLowerCase() === managerEmail) : null;
  // Project journey/checklist rendering (renderProjectOverview,
  // journeyStageRange, checklistItemDone, etc. in app.html) is ONE shared
  // code path for every role -- it was never written twice. That code
  // reads b.startDate / b.productionDays / b.productionCompletionOverride /
  // b.targetDeliveryOverride / b.projectStage / b.deliveredAt / b.paused
  // directly, and none of those were in this object before, so a factory
  // session ran the exact same formulas as Carve Admin's but with those
  // inputs silently undefined -- producing a DIFFERENT date (or none) for
  // the same project depending who was looking. Sending the vendor the
  // same "prescribed" schedule fields Carve Admin/Client Manager set (not
  // a separately-computed vendor-only estimate) is what keeps both sides
  // showing the exact same journey. clientQuote itself stays withheld
  // (that's the client-facing PRICE) -- only the two non-price pieces the
  // shared code actually needs come along: the agreed day count and the
  // deposit-paid status/date the "50% deposit received" checklist item and
  // getProjectStartDate's fallback read.
  var clientQuoteSafe = null;
  if (b.clientQuote) {
    var inv = b.clientQuote.invoice || null;
    clientQuoteSafe = {
      days: b.clientQuote.days == null ? null : b.clientQuote.days,
      invoice: inv ? { depositStatus: inv.depositStatus || null, depositPaidAt: inv.depositPaidAt || null, balanceStatus: inv.balanceStatus || null } : null,
    };
  }
  return {
    id: b.id,
    title: b.title,
    code: b.code || null,
    brief: b.brief || {},
    notes: b.notes || null,
    files: b.files || [],
    link: b.link || null,
    status: b.status || null,
    awarded: b.awarded || null,
    awardedVariantIndex: b.awardedVariantIndex == null ? null : b.awardedVariantIndex,
    stage: b.stage || null,
    projectStage: b.projectStage || null,
    deliveredAt: b.deliveredAt || null,
    paused: !!b.paused,
    startDate: b.startDate || null,
    productionDays: b.productionDays == null ? null : b.productionDays,
    productionCompletionOverride: b.productionCompletionOverride || null,
    targetDeliveryOverride: b.targetDeliveryOverride || null,
    scaleOverride: b.scaleOverride || null,
    boundaryFileOverride: b.boundaryFileOverride || null,
    // Facade/landscape material samples (elevations, pins, site plan) --
    // exclusively vendor-authored (see vendorScopedBriefUpdate's own
    // comment on this same field for the POST side, which already carries
    // it through). This GET-side allowlist never included it, so a
    // factory session's own poll -- the one thing driving its local copy
    // of every other field -- had no way to see its own previously-saved
    // elevations/pins on a fresh load or a different device/tab, and
    // (worse) a factory-scoped pull's replace-not-merge policy in
    // app.html (isScopedPull) meant this missing field overwrote whatever
    // elevations were already in memory with nothing, reproducing "Add an
    // elevation first"/"Upload this elevation first" on literally every
    // poll, not just a mistimed one.
    materialSamples: b.materialSamples || null,
    // Whether Carve has paid the VENDOR's 50% deposit / 100% balance so far
    // -- the mirror image of clientQuote.invoice (which tracks the CLIENT's
    // payments to Carve), but this one is Carve-Admin/Client-Manager-entered
    // only and never writable by the vendor's own save (see
    // vendorScopedBriefUpdate, which does not carry this field over from a
    // factory-role POST). The vendor sees it read-only in their own Vendor
    // Payment panel, alongside their own already-known quoted price, so
    // they know where payment stands without having to ask -- no dollar
    // amounts beyond what the vendor already quoted are exposed here.
    // Redacted for a Vendor Team & Access member (isPrimary===false) --
    // see resolveFactoryShop() above and the vendor-invoice-only/
    // vendor-invoice-edit-only PERM classes in app.html for the matching
    // client-side hiding of the price these numbers sit alongside.
    vendorInvoice: isPrimary ? (b.vendorInvoice || null) : null,
    scaleBoundaryConfirmedAt: b.scaleBoundaryConfirmedAt || null,
    designFilesChecklist: b.designFilesChecklist || null,
    stageChecklist: b.stageChecklist || null,
    pendingChanges: b.pendingChanges || [],
    clientQuote: clientQuoteSafe,
    assignedTech: b.assignedTech || null,
    assignedTeamMembers: b.assignedTeamMembers || [],
    assignedManagerName: manager ? manager.name : null,
    invited: b.invited || [],
    sentDate: b.sentDate || null,
    leadReceivedAt: b.leadReceivedAt || null,
    lastCommentAt: b.lastCommentAt || null,
    archived: !!b.archived,
    quotes,
    variations,
  };
}
function isBriefRelevantToShop(b, shopId) {
  return !!(b && ((b.invited || []).indexOf(shopId) >= 0 || (b.quotes && b.quotes[shopId]) || b.awarded === shopId));
}
function filterDataForFactory(data, email) {
  // Resolves against BOTH the shop's own vendors record (the primary/
  // designated admin) and vendorTeam (an admin-added team member) -- see
  // resolveFactoryShop() above. No match for this email in either place —
  // same fail-closed rule as before: show nothing rather than guess. See
  // SRC_prodAdmin's '' guard in app.html.
  const { shopId, isPrimary, vendor, memberId } = resolveFactoryShop(data, email);
  if (!shopId) return { briefs: [], leads: [], vendors: [], team: [], vendorTeam: [] };
  let relevantBriefs = (data.briefs || []).filter((b) => isBriefRelevantToShop(b, shopId));
  // A Vendor Team & Access member (isPrimary===false) only sees a project
  // once the shop's own admin has assigned THEM to it specifically
  // (b.assignedTeamMembers, set via the Assigned Team Members panel on the
  // vendor's Project Overview page) -- the primary admin still sees every
  // job awarded to the shop, unfiltered, same as always. This only applies
  // to jobs already AWARDED to this shop: a still-quoting brief (invited/
  // quoted but not yet awarded) stays visible to every team member exactly
  // like before, since the Quotes/Sourcing workflow itself is untouched by
  // this per-project assignment feature.
  if (!isPrimary) {
    relevantBriefs = relevantBriefs.filter((b) => {
      if (b.awarded === shopId) return (b.assignedTeamMembers || []).indexOf(memberId) >= 0;
      return true;
    });
  }
  const briefs = relevantBriefs.map((b) => vendorSafeBrief(b, shopId, data.team, isPrimary));
  // Only the caller's OWN vendor record — needed so their own device can
  // resolve its own shopId (see reconcileVendorsIntoShops in app.html) —
  // never the full roster. Same for vendorTeam: only THIS shop's own added
  // team members, never another shop's roster.
  const vendorTeam = (data.vendorTeam || []).filter((t) => t && t.shopId === shopId);
  return { briefs, leads: [], vendors: vendor ? [vendor] : [], team: [], vendorTeam };
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
      if (!data.vendors) data.vendors = [];
      if (!data.team) data.team = [];
      if (!data.vendorTeam) data.vendorTeam = [];
      if (!data.companies) data.companies = [];
      const query = req.query || {};
      if (query.role) {
        const session = await resolveSession(redis, query.token);
        if (!session) {
          // Claimed a role but the token backing it doesn't verify (missing,
          // expired, or simply never issued because this session predates
          // the token system). Fail loudly, not quietly — see the note on
          // verifiedIdentity above for why a silent fallback here is exactly
          // how the vendor/team roster went missing.
          res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
          return;
        }
        const identity = verifiedIdentity(query.role, session);
        if (identity.role === 'factory') {
          res.status(200).json(filterDataForFactory(data, identity.email));
          return;
        }
        // A verified session that isn't factory (owner/sales/prodtech/etc.)
        // falls through to the normal full-data response below — unchanged
        // from today's trust level for admin roles.
      }
      res.status(200).json(data);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};
      // See verifiedIdentity() above: body.role is only ever trusted if a
      // real session token backs it up, and a role claim that DOESN'T check
      // out fails the request outright (401) rather than silently degrading
      // it — that silent-degrade behavior is exactly how a real vendor/team
      // roster went missing with no error ever shown. A request with no
      // role field at all (the public contact form's anonymous lead
      // submission, most notably) is untouched by this and behaves exactly
      // as before.
      let identity = { role: null, email: null };
      if (body.role) {
        const postSession = await resolveSession(redis, body.token);
        if (!postSession) {
          res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
          return;
        }
        identity = verifiedIdentity(body.role, postSession);
      }

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
      if (!current.vendors) current.vendors = [];
      if (!current.team) current.team = [];
      if (!current.vendorTeam) current.vendorTeam = [];
      if (!current.companies) current.companies = [];

      // A factory (vendor) caller's local briefs are the server-FILTERED,
      // redacted view from GET (see filterDataForFactory) — their browser
      // never had the client's contact info, Carve's client-facing price,
      // or any OTHER shop's quotes/variations to begin with. If their POST
      // were allowed to overwrite a changed brief wholesale like any other
      // caller's, that missing data would be genuinely DELETED from the
      // shared store the instant they submitted a quote, not just hidden
      // from their own view. So for a factory caller, rewrite each brief
      // they're allowed to touch (per changedBriefIds) into "the currently
      // stored brief, with only that vendor's own quotes[shopId] /
      // variations[shopId] swapped in" — everything else on it (client,
      // clientQuote, every other shop's data, status, award, etc.) is left
      // exactly as already stored, completely untouched by whatever the
      // vendor's necessarily-incomplete local copy contains.
      function vendorScopedBriefUpdate(currentBrief, incomingBrief, shopId) {
        const merged = Object.assign({}, currentBrief);
        const quotes = Object.assign({}, currentBrief.quotes || {});
        if (incomingBrief.quotes && incomingBrief.quotes[shopId]) quotes[shopId] = incomingBrief.quotes[shopId];
        else delete quotes[shopId];
        merged.quotes = quotes;
        const variations = Object.assign({}, currentBrief.variations || {});
        if (incomingBrief.variations && incomingBrief.variations[shopId]) variations[shopId] = incomingBrief.variations[shopId];
        else delete variations[shopId];
        merged.variations = variations;
        // The vendor side has grown real write access beyond just quotes/
        // variations since this function was first written -- toggling the
        // Design files checklist (toggleDesignFileItem), filling in Scale &
        // boundary (saveScaleBoundaryScale/uploadProjectBoundaryFile), and
        // filing a change request (submitProjectInfoChangeRequest) all call
        // the same saveSRC() path. Without carrying these over too, every
        // one of those silently appeared to save (no error, UI updated
        // instantly from local state) but reverted the moment this vendor's
        // own next pull replaced their local copy with the untouched
        // server version -- exactly the "checked all the boxes, logged
        // back in, nothing was checked" bug.
        merged.designFilesChecklist = incomingBrief.designFilesChecklist || currentBrief.designFilesChecklist || null;
        merged.scaleOverride = incomingBrief.scaleOverride != null ? incomingBrief.scaleOverride : (currentBrief.scaleOverride || null);
        merged.boundaryFileOverride = incomingBrief.boundaryFileOverride || currentBrief.boundaryFileOverride || null;
        // materialSamples (facade elevations/pins + landscape plan/pins, see
        // ensureMaterialSamples in app.html) grew here after the fields
        // above were already enumerated -- same "silently appeared to
        // save, reverted the moment this vendor's next pull replaced their
        // local copy" bug those were written to fix, just never extended
        // to cover this one. This is exactly what made facade elevations
        // (and any uploaded elevation photo) look like they saved
        // instantly, then come back "Add an elevation first"/"Upload this
        // elevation first" a poll cycle later -- the vendor's whole
        // materialSamples payload was being silently dropped here, so the
        // server never actually had the seeded elevations (or the
        // uploaded image) to hand back on the next pull.
        //
        // Facade is vendor-only edited (only factory/prodtech ever calls
        // fmAddElevation/fmUploadElevationImage/fmDeletePin etc.), so the
        // incoming snapshot can simply win outright, same as
        // designFilesChecklist above. Landscape is NOT vendor-only though
        // -- the client can add their own comment pin or approve a
        // vendor's pin directly (see lmApprovePin/lmSamplePicked's
        // client-origin branch in app.html), so blindly trusting this
        // vendor's incoming copy could revert a client pin added between
        // this vendor's last pull and now. Merge landscape.pins by id
        // instead (union, incoming wins on an id collision) so neither
        // side's pins get dropped.
        {
          const currentMs = currentBrief.materialSamples || null;
          const incomingMs = incomingBrief.materialSamples || null;
          if (incomingMs) {
            const mergedMs = Object.assign({}, incomingMs);
            if (currentMs && currentMs.landscape) {
              const currentPins = currentMs.landscape.pins || [];
              const incomingPins = (incomingMs.landscape && incomingMs.landscape.pins) || [];
              const incomingPinIds = new Set(incomingPins.map((p) => p && p.id));
              const keptCurrentPins = currentPins.filter((p) => !p || !incomingPinIds.has(p.id));
              mergedMs.landscape = Object.assign({}, currentMs.landscape, incomingMs.landscape || {}, {
                pins: keptCurrentPins.concat(incomingPins)
              });
            }
            merged.materialSamples = mergedMs;
          } else if (currentMs) {
            merged.materialSamples = currentMs;
          }
        }
        // pendingChanges is additive-only from the vendor's side (they can
        // only ever propose a NEW change, never touch an existing one's
        // status -- see resolvePendingChange, owner/sales only): merge by
        // id, keeping the server's copy of anything already there
        // (protects a Carve Admin resolution that landed between this
        // vendor's last pull and this save from being reverted by their
        // stale local copy) and only ADDING ids the server doesn't have
        // yet.
        const pendingChanges = (currentBrief.pendingChanges || []).slice();
        const existingChangeIds = new Set(pendingChanges.map((c) => c && c.id));
        (incomingBrief.pendingChanges || []).forEach((c) => {
          if (c && c.id && !existingChangeIds.has(c.id)) pendingChanges.unshift(c);
        });
        merged.pendingChanges = pendingChanges;
        // Which of this shop's OWN team members (Team & Access) are
        // assigned to this specific project -- drives the Assigned Team
        // Members panel on the vendor's Project Overview page and the
        // per-member visibility scoping in filterDataForFactory above.
        // Either the primary admin or a team member may set this (full
        // parity, same as everything else a factory session can edit) --
        // sanitized here against THIS shop's actual vendorTeam roster so a
        // tampered payload can't assign an id that isn't really a member
        // of this shop (or worse, another shop's member id).
        if (Array.isArray(incomingBrief.assignedTeamMembers)) {
          const shopMemberIds = new Set((current.vendorTeam || []).filter((t) => t && t.shopId === shopId).map((t) => t.id));
          merged.assignedTeamMembers = incomingBrief.assignedTeamMembers.filter((id) => shopMemberIds.has(id));
        } else {
          merged.assignedTeamMembers = currentBrief.assignedTeamMembers || [];
        }
        return merged;
      }
      let briefsForMerge = body.briefs;
      let factoryShopId = null;
      if (identity.role === 'factory') {
        // Resolves against BOTH the shop's own vendors record and vendorTeam
        // (an added team member) -- see resolveFactoryShop() above. A team
        // member gets exactly the same scoped write access as the primary
        // admin here; isPrimary only matters for the price/vendorInvoice
        // redaction on GET, never for what a factory session may edit.
        const resolved = resolveFactoryShop(current, identity.email);
        factoryShopId = resolved.shopId;
        const allowed = new Set(body.changedBriefIds || []);
        briefsForMerge = factoryShopId ? (body.briefs || [])
          .filter((incoming) => incoming && incoming.id && allowed.has(incoming.id))
          .map((incoming) => {
            const cur = current.briefs.find((b) => b && b.id === incoming.id);
            // A vendor's own brand-new brief should never happen (they only
            // ever act on briefs Carve already sent them) — if it somehow
            // did, there's nothing safe to scope it against, so drop it
            // rather than trust it wholesale.
            return cur ? vendorScopedBriefUpdate(cur, incoming, factoryShopId) : null;
          })
          .filter(Boolean) : []; // no matched vendor — fail closed, same rule as GET
      }

      // Snapshot which lead ids already existed BEFORE merging, so a
      // notification only fires for ids that are genuinely new — an admin
      // re-saving an existing lead (status change, note edit, etc.) must
      // never re-trigger the email.
      const existingLeadIds = new Set(current.leads.map((l) => l && l.id));
      const newLeads = identity.role === 'factory' ? [] : (body.leads || []).filter((l) => l && l.id && !existingLeadIds.has(l.id));
      const newQuotes = detectNewQuotes(current.briefs, briefsForMerge);
      const newChangeRequests = detectNewChangeRequests(current.briefs, briefsForMerge);

      // allowedIds, when given, restricts what an incoming item is allowed to
      // OVERWRITE: for an id that already exists in currentList, the incoming
      // copy is only accepted if its id is in allowedIds — otherwise whatever
      // is already stored is kept as-is. This closes a real bug: saveSRC()
      // in app.html POSTs this browser tab's ENTIRE local briefs array on
      // every single save, anywhere in the app — adding a vendor, renaming a
      // team member, anything. If that tab's local copy of some OTHER brief
      // hasn't caught up with a recent change yet (e.g. it's been open a
      // while and missed the last poll, or two saves from different
      // people/tabs raced), the old code would still blindly take that stale
      // copy and stomp the newer one — observed as a vendor's just-submitted
      // quote vanishing and the project going back to "awaiting quote"
      // minutes later, because some unrelated save elsewhere overwrote it
      // with a snapshot from before the quote existed. Brand-new ids (not
      // already in currentList) are always accepted regardless of
      // allowedIds — a caller can't have stale data for a record that didn't
      // exist yet. allowedIds is optional and defaults to "trust everything"
      // (the original behavior) so older/unmigrated call sites that don't
      // pass it keep working exactly as before.
      function mergeById(currentList, incomingList, deletedIds, allowedIds) {
        const deleted = new Set(deletedIds || []);
        const allowed = allowedIds ? new Set(allowedIds) : null;
        const byId = new Map();
        (currentList || []).forEach((item) => { if (item && item.id) byId.set(item.id, item); });
        (incomingList || []).forEach((item) => {
          if (!item || !item.id) return;
          if (allowed && byId.has(item.id) && !allowed.has(item.id)) return;
          byId.set(item.id, item);
        });
        deleted.forEach((id) => byId.delete(id));
        return Array.from(byId.values());
      }

      // vendors/team merge the same way leads do (no changedIds protection —
      // these are lower-collision, effectively admin-only edits). Persisting
      // them here at all is the actual fix for a real cross-account leak:
      // these two lists used to live ONLY in whichever browser tab created
      // them (app.html's PRODUCTION_ADMINS/SHOPS, rebuilt from SDB.vendors,
      // which was localStorage-only). A vendor added on Carve Admin's laptop
      // simply didn't exist yet on that vendor's own device — so when they
      // logged in, their email matched nothing, and the portal silently fell
      // back to showing whichever OTHER shop happened to be the default,
      // i.e. one vendor's account displaying a different vendor's quotes.
      // A factory caller must never be able to touch the vendors/team
      // rosters or the leads list — those are Carve-admin-only data. Their
      // local copies of those lists (from the GET filter) are already
      // empty/self-only, but nothing previously stopped a crafted POST body
      // from smuggling in extra entries; fail closed by ignoring those
      // fields entirely for factory-role saves.
      const isFactorySave = identity.role === 'factory';
      // vendorTeam is the one exception to "a factory caller can never touch
      // the vendors/team rosters": Vendor Team & Access (app.html) lets a
      // factory session (primary admin or an already-added team member) add
      // more team members for their OWN shop. Scope it exactly like
      // vendorScopedBriefUpdate scopes briefs -- only rows for factoryShopId
      // may be added/removed; every other shop's roster passes through
      // from `current` completely untouched, so one vendor's crafted POST
      // can never add/remove another shop's team members.
      let vendorTeamForMerge;
      if (isFactorySave) {
        if (factoryShopId) {
          const others = current.vendorTeam.filter((t) => !t || t.shopId !== factoryShopId);
          const deletedOwn = new Set(body.deletedVendorTeamIds || []);
          const keptOwn = current.vendorTeam.filter((t) => t && t.shopId === factoryShopId && !deletedOwn.has(t.id));
          const incomingOwn = (body.vendorTeam || []).filter((t) => t && t.shopId === factoryShopId);
          vendorTeamForMerge = others.concat(mergeById(keptOwn, incomingOwn, [], null));
        } else {
          vendorTeamForMerge = current.vendorTeam; // no matched shop — fail closed, same rule as briefs
        }
      } else {
        vendorTeamForMerge = mergeById(current.vendorTeam, body.vendorTeam, body.deletedVendorTeamIds);
      }
      const data = {
        briefs: mergeById(current.briefs, briefsForMerge, isFactorySave ? [] : body.deletedBriefIds, body.changedBriefIds),
        leads: isFactorySave ? current.leads : mergeById(current.leads, body.leads, body.deletedLeadIds),
        vendors: isFactorySave ? current.vendors : mergeById(current.vendors, body.vendors, body.deletedVendorIds),
        team: isFactorySave ? current.team : mergeById(current.team, body.team, body.deletedTeamIds),
        vendorTeam: vendorTeamForMerge,
        // companies (Clients tab) is Owner-only data, same as vendors/team —
        // a factory session never touches it (isFactorySave keeps whatever
        // was already stored, untouched, same fail-closed rule as the rest
        // of this block).
        companies: isFactorySave ? current.companies : mergeById(current.companies, body.companies, body.deletedCompanyIds),
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
      const claimedChangeRequests = await filterClaimed(redis, newChangeRequests, (c) => (
        'carve:notified:change:' + c.brief.id + ':' + c.change.id
      ));
      const notifications = [
        ...claimedLeads.map((l) => sendLeadNotification(l)),
        ...claimedLeads.map((l) => sendOpenAiConversionEvent(l)),
        ...claimedQuotes.map((q) => sendQuoteNotification(q)),
        ...claimedChangeRequests.map((c) => sendChangeRequestNotification(c)),
      ];
      if (notifications.length) {
        await Promise.allSettled(notifications);
      }

      res.status(200).json({ ok: true, briefs: data.briefs, leads: data.leads, vendors: data.vendors, team: data.team, vendorTeam: data.vendorTeam, companies: data.companies });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sourcing API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
