// Shared helpers for portfolio images (used by /works and the homepage).
//
// Each project keeps TWO versions of its cover photo:
//   imageUrl / imageWidth / imageHeight           -> the untouched original (used by the lightbox)
//   cardImageUrl / cardImageWidth / cardImageHeight -> an optimized ~1200px WebP for grid cards
// Projects saved before the optimized version existed have no cardImageUrl, so
// everything here falls back to the original and keeps working unchanged.

// A project saved with photos only under "Additional photos" (and nothing in
// the cover square) would otherwise render as an empty frame on the grid.
// Promote the first additional photo to the cover in that case.
export function withCover(p) {
  if (!p || p.imageUrl) return p;
  const extra = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
  if (!extra.length) return p;
  return { ...p, imageUrl: extra[0], imageWidth: 0, imageHeight: 0, cardImageUrl: '', images: extra.slice(1) };
}

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

// Accurate, descriptive alt text. An explicit p.alt (editable in /admin-works)
// always wins; otherwise build one from the project's own details.
export function workAlt(p, categoryLabel) {
  if (p.alt && String(p.alt).trim()) return String(p.alt).trim();
  const kind = categoryLabel ? `${categoryLabel} physical model` : 'Physical model';
  const details = [p.scale && `${p.scale} scale`, p.material].filter(Boolean).join(', ');
  return `${p.name} — ${kind} by Carve Model${details ? ` (${details})` : ''}`;
}
