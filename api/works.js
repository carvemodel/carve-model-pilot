// Vercel serverless function — shared read/write store for the Works
// (project portfolio) data shown on /works. Lives on the SAME domain as the
// site, same pattern as api/sourcing.js: one JSON document in the Redis
// database already connected to this project (env var REDIS_URL).
//
// GET is public — it returns exactly what's already visible to any visitor
// on the live /works page, so there's nothing sensitive to protect there.
// POST (writing new project data) requires a shared secret so random
// visitors can't rewrite the portfolio: set WORKS_ADMIN_TOKEN in the
// project's Environment Variables (Vercel dashboard → Settings →
// Environment Variables) and enter that same value in admin-works.html.

const { createClient } = require('redis');

const KEY = 'carve:works';
let clientPromise;

function getClient() {
  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis client error:', err));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
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
      const data = raw ? JSON.parse(raw) : { projects: [] };
      if (!Array.isArray(data.projects)) data.projects = [];
      res.status(200).json(data);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};

      const expected = process.env.WORKS_ADMIN_TOKEN;
      if (!expected) {
        res.status(500).json({ error: 'WORKS_ADMIN_TOKEN is not configured on the server.' });
        return;
      }
      if (body.token !== expected) {
        res.status(401).json({ error: 'Invalid admin token.' });
        return;
      }

      const projects = Array.isArray(body.projects) ? body.projects : [];
      await redis.set(KEY, JSON.stringify({ projects }));
      res.status(200).json({ ok: true, count: projects.length });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Works API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
