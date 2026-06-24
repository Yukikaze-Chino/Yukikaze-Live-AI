export function fitFontSize({
  preferredSize,
  minimumSize,
  fitsAtSize,
}) {
  const preferred = Math.max(1, Math.floor(Number(preferredSize) || 1));
  const minimum = Math.min(
    preferred,
    Math.max(1, Math.floor(Number(minimumSize) || 1)),
  );
  for (let size = preferred; size >= minimum; size -= 1) {
    if (fitsAtSize(size)) return size;
  }
  return minimum;
}
