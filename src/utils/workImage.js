// Shared helpers for portfolio images (used by /works and the homepage).
//
// Each project keeps TWO versions of its cover photo:
//   imageUrl / imageWidth / imageHeight           -> the untouched original (used by the lightbox)
//   cardImageUrl / cardImageWidth / cardImageHeight -> an optimized ~1200px WebP for grid cards
// Projects saved before the optimized version existed have no cardImageUrl, so
// everything here falls back to the original and keeps working unchanged.

export function cardImage(p) {
  if (p.cardImageUrl) {
    return {
      src: p.cardImageUrl,
      width: p.cardImageWidth || p.imageWidth || undefined,
      height: p.cardImageHeight || p.imageHeight || undefined,
    };
  }
  return {
    src: p.imageUrl,
    width: p.imageWidth || undefined,
    height: p.imageHeight || undefined,
  };
}

// A bare number like "200" is shown as the ratio "1:200"; anything else
// ("1:500", "1/16\" = 1'0\"", "Film-grade", "N/A") is shown as entered.
export function formatScale(scale) {
  const t = String(scale == null ? '' : scale).trim();
  return /^\d+(\.\d+)?$/.test(t) ? `1:${t}` : t;
}

// Accurate, descriptive alt text. An explicit p.alt (editable in /admin-works)
// always wins; otherwise build one from the project's own details.
export function workAlt(p, categoryLabel) {
  if (p.alt && String(p.alt).trim()) return String(p.alt).trim();
  const kind = categoryLabel ? `${categoryLabel} physical model` : 'Physical model';
  const details = [p.scale && `${formatScale(p.scale)} scale`, p.material].filter(Boolean).join(', ');
  return `${p.name} — ${kind} by Carve Model${details ? ` (${details})` : ''}`;
}

// Gallery cards are served at 480 / 800 / 1200px through Vercel Image Optimization
// (allowed widths + the blob host are declared under "images" in vercel.json).
// The full-resolution original stays in data-full for the lightbox.
export const CARD_WIDTHS = [480, 800, 1200];
export function cardSrcset(url, maxWidth) {
  if (!url || !/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(url)) return undefined;
  const ws = CARD_WIDTHS.filter((w) => !maxWidth || w <= maxWidth);
  if (ws.length < 2) return undefined;
  return ws.map((w) => `/_vercel/image?url=${encodeURIComponent(url)}&w=${w}&q=75 ${w}w`).join(', ');
}
// If the optimizer is ever unavailable, fall back to the plain card URL.
export const CARD_FALLBACK = "this.onerror=null;this.removeAttribute('srcset');this.removeAttribute('sizes');";
