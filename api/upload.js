// Vercel serverless function — uploads a single file to Vercel Blob storage and
// returns its public URL. Runs on the SAME domain as the site, and the resulting
// blob URL is served over Vercel's own edge network (like the rest of the site) —
// no Google/Firebase domains involved, so it's reachable everywhere the site is.

const { put } = require('@vercel/blob');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const rawName = req.headers['x-file-name'] || 'upload';
    const fileName = decodeURIComponent(rawName);
    const pathPrefix = (req.query && req.query.path) ? String(req.query.path) : 'leads';

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const blob = await put(pathPrefix + '/' + Date.now() + '-' + fileName, buffer, {
      access: 'public',
      addRandomSuffix: true,
    });

    res.status(200).json({ url: blob.url, name: fileName });
  } catch (err) {
    console.error('Upload API error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
};
