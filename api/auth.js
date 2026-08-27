// Vercel serverless function — real account creation + login for the Carve
// Studio Portal, backing the standalone /login page.
//
// Two Redis-backed record types (same REDIS_URL as api/sourcing.js and
// api/works.js):
//   carve:invite:<token>   — set by api/team-invite.js (directly, and also
//                            creatable here via action "createInvite" for
//                            other invite flows, e.g. "Invite a client")
//                            when someone is added. Holds {name,email,role}.
//                            Expires after 7 days via Redis TTL — once it's
//                            gone, the invite link is dead. Deleted the
//                            moment it's accepted, so a link can't be reused.
//   carve:user:<email>     — created the moment an invite is accepted.
//                            Holds {name,email,role,salt,hash}. Password is
//                            never stored in the clear — scrypt (Node's
//                            built-in crypto, no extra dependency) with a
//                            random salt per user.
//
// Legacy demo accounts (support@physical-model.com, etc. — see ACCOUNTS in
// app.html) aren't stored here and keep working exactly as before: this
// endpoint only rejects a login if the email matches neither a real
// carve:user record nor a legacy demo account.
//
// Also handles: "updateAccount" (self-service email/password change for any
// logged-in role) and the two Owner-only Team & Access actions,
// "adminResetAccess" (revoke a team member's/vendor's current password so
// Carve Admin can always regain control of their access) and
// "adminRemoveAccount" (revoke login entirely when removing someone from the
// roster). Note: like api/team-invite.js, none of these endpoints verify the
// caller is actually an Owner — the app has no server-side session/auth
// check yet, only client-side role gating (the Team & Access page itself is
// hidden from non-Owner roles). That's an existing limitation of this pilot,
// not something new introduced here.

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

// Mirrors ACCOUNTS in app.html — kept in sync manually since the client
// still needs its own copy for the pre-login role-aware UI. Only used as a
// fallback when no real carve:user record exists for the email yet.
const LEGACY_ACCOUNTS = {
  'cliu@carvecreation.com': 'client',
  'support@physical-model.com': 'owner',
  'cliu@physical-model.com': 'sales',
  '13918826884@163.com': 'factory',
};

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days, matches the copy shown in both invite emails

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const attempt = hashPassword(password, salt);
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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
    const action = body.action;
    const redis = await getClient();

    if (action === 'createInvite') {
      // Called by api/team-invite.js right after it sends the email, so the
      // token in that email actually resolves to something server-side.
      const { token, name, email, role } = body;
      if (!token || !email) { res.status(400).json({ error: 'token and email are required.' }); return; }
      await redis.set('carve:invite:' + token, JSON.stringify({ name, email, role }), { EX: INVITE_TTL_SECONDS });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'resolveInvite') {
      const { token } = body;
      if (!token) { res.status(400).json({ error: 'token is required.' }); return; }
      const raw = await redis.get('carve:invite:' + token);
      if (!raw) { res.status(404).json({ error: 'This invite link is invalid or has expired.' }); return; }
      const invite = JSON.parse(raw);
      res.status(200).json({ ok: true, name: invite.name, email: invite.email, role: invite.role });
      return;
    }

    if (action === 'acceptInvite') {
      const { token, password } = body;
      if (!token || !password || password.length < 8) {
        res.status(400).json({ error: 'A token and a password of at least 8 characters are required.' });
        return;
      }
      const raw = await redis.get('carve:invite:' + token);
      if (!raw) { res.status(404).json({ error: 'This invite link is invalid or has expired.' }); return; }
      const invite = JSON.parse(raw);
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const emailKey = invite.email.toLowerCase();
      await redis.set('carve:user:' + emailKey, JSON.stringify({ name: invite.name, email: invite.email, role: invite.role, salt, hash }));
      await redis.del('carve:invite:' + token);
      res.status(200).json({ ok: true, name: invite.name, email: invite.email, role: invite.role });
      return;
    }

    if (action === 'updateAccount') {
      // Self-service: any logged-in person (any role) changing their own
      // email and/or password from the portal's Account Settings modal.
      const { email, currentPassword, newEmail, newPassword } = body;
      if (!email || !currentPassword) {
        res.status(400).json({ error: 'Current email and password are required.' });
        return;
      }
      const emailKey = String(email).toLowerCase();
      const raw = await redis.get('carve:user:' + emailKey);
      let existing = raw ? JSON.parse(raw) : null;
      if (existing) {
        if (!verifyPassword(currentPassword, existing.salt, existing.hash)) {
          res.status(401).json({ error: 'Current password is incorrect.' });
          return;
        }
      } else {
        // No real account yet — this is a legacy demo account (any password
        // accepted for those, same as login). Confirm it's at least a
        // recognized email, then let this call create their first real
        // account record, same as accepting an invite would.
        const legacyRole = LEGACY_ACCOUNTS[emailKey];
        if (!legacyRole) {
          res.status(404).json({ error: "That email isn't recognized." });
          return;
        }
        existing = { name: null, email, role: legacyRole, salt: null, hash: null };
      }

      const targetEmailKey = newEmail ? String(newEmail).toLowerCase().trim() : emailKey;
      if (newEmail && targetEmailKey !== emailKey) {
        const taken = await redis.get('carve:user:' + targetEmailKey);
        if (taken) {
          res.status(409).json({ error: 'That email is already in use.' });
          return;
        }
      }

      let salt = existing.salt;
      let hash = existing.hash;
      if (newPassword) {
        if (newPassword.length < 8) {
          res.status(400).json({ error: 'New password must be at least 8 characters.' });
          return;
        }
        salt = crypto.randomBytes(16).toString('hex');
        hash = hashPassword(newPassword, salt);
      }
      if (!salt || !hash) {
        // Legacy account changing only its email, with no password ever set —
        // require a password in the same request so the new email is
        // actually usable to log in afterward (LEGACY_ACCOUNTS is keyed by
        // the OLD email and won't recognize the new one).
        res.status(400).json({ error: 'Set a password to finish updating your account.' });
        return;
      }

      const updated = {
        name: existing.name,
        email: newEmail ? newEmail.trim() : existing.email,
        role: existing.role,
        salt,
        hash,
      };
      await redis.set('carve:user:' + targetEmailKey, JSON.stringify(updated));
      if (targetEmailKey !== emailKey) {
        await redis.del('carve:user:' + emailKey);
      }
      res.status(200).json({ ok: true, email: updated.email, role: updated.role, name: updated.name });
      return;
    }

    if (action === 'adminResetAccess') {
      // Owner-triggered: revoke whatever password an account currently has
      // (set by the person themselves, or previously reset) so Carve Admin
      // always has a path back into managing a team member's or vendor's
      // access, regardless of what password they've since chosen. The
      // account isn't deleted from the roster — only the password record —
      // so re-sending an invite (api/team-invite.js) lets them set a new one.
      const { email } = body;
      if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
      await redis.del('carve:user:' + String(email).toLowerCase());
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'adminRemoveAccount') {
      // Owner-triggered: fully revoke login access when removing a team
      // member or vendor from the roster (called alongside deleting them
      // from SDB.team/vendors client-side).
      const { email } = body;
      if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
      await redis.del('carve:user:' + String(email).toLowerCase());
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'login') {
      const { email, password } = body;
      if (!email || !password) { res.status(400).json({ error: 'Email and password are required.' }); return; }
      const emailKey = String(email).toLowerCase();
      const raw = await redis.get('carve:user:' + emailKey);
      if (raw) {
        const user = JSON.parse(raw);
        if (verifyPassword(password, user.salt, user.hash)) {
          res.status(200).json({ ok: true, name: user.name, email: user.email, role: user.role });
        } else {
          res.status(401).json({ error: 'Incorrect password.' });
        }
        return;
      }
      // No real account yet — fall back to the legacy demo accounts (any
      // non-empty password accepted), same behavior as before this endpoint
      // existed, so nothing already using those breaks.
      const legacyRole = LEGACY_ACCOUNTS[emailKey];
      if (legacyRole) {
        res.status(200).json({ ok: true, name: null, email: email, role: legacyRole });
        return;
      }
      res.status(404).json({ error: "That email isn't recognized. Check with your Carve Model contact." });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('auth API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
