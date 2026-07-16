// Vercel serverless function — upload endpoint for Vercel Blob storage.
//
// Two paths are supported:
//
// 1. Client-direct upload (used by app.html for the "Add lead" file picker).
//    The browser's @vercel/blob/client `upload()` call POSTs a small JSON
//    "give me a token" request here first, then PUTs the file bytes straight
//    to Blob storage — never through this function. This is required for
//    anything over ~4.5MB: Vercel enforces a hard body-size cap on
//    serverless functions, so large files (CAD/.nwd, video, etc.) silently
//    fail if buffered through the function itself, which is what this
//    endpoint used to do.
//
// 2. Legacy direct-through-the-function upload (fallback for older browsers
//    without dynamic `import()` support). The browser POSTs the raw file
//    bytes with an `X-File-Name` header; this function buffers and stores
//    them itself. Only safe for small files.
//
// The two paths are distinguished by Content-Type: the client-upload token
// request is always `application/json`; the legacy path sends the file's
// own content type (or octet-stream).

const { put } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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

  const contentType = String(req.headers['content-type'] || '');

  // --- Path 1: client-direct upload token handshake ---
  if (contentType.indexOf('application/json') !== -1) {
    try {
      const raw = await readRawBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};

      const jsonResponse = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({
          // No allowedContentTypes here on purpose: Vercel Blob only supports
          // real wildcard patterns like "image/*", not a bare "*/*" — passing
          // that literal string caused the Blob backend to reject every
          // upload with "Content type mismatch ... is not allowed", since no
          // real file ever has a contentType of exactly "*/*". Omitting the
          // field entirely defaults to allowing all content types, which is
          // what we actually want (CAD/Rhino/SketchUp files report all sorts
          // of generic or missing MIME types).
          addRandomSuffix: true,
        }),
        onUploadCompleted: async () => {
          // No server-side bookkeeping needed here — app.html records the
          // resulting blob URL itself once the client-side upload() promise
          // resolves, so there's nothing to do in this callback.
        },
      });

      res.status(200).json(jsonResponse);
    } catch (err) {
      console.error('Blob client-upload token error:', err);
      res.status(400).json({ error: err.message || 'Upload token request failed' });
    }
    return;
  }

  // --- Path 2: legacy direct-through-the-function upload (small files only) ---
  try {
    const rawName = req.headers['x-file-name'] || 'upload';
    const fileName = decodeURIComponent(rawName);
    const pathPrefix = (req.query && req.query.path) ? String(req.query.path) : 'leads';

    const buffer = await readRawBody(req);

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
