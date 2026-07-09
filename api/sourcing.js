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
      const data = { briefs: body.briefs || [], leads: body.leads || [] };
      await redis.set(KEY, JSON.stringify(data));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sourcing API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
