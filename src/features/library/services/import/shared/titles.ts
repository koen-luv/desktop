function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function withoutArtistPrefix(title: string, artist: string | undefined): string {
  if (!artist) return title;
  const match = /^(.+?)\s*[-–—]\s*(.+)$/.exec(title.trim());
  return match && normalized(match[1]) === normalized(artist) ? match[2].trim() : title;
}
