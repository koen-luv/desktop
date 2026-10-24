/** Upper bound for the source file; the stored cover is tiny after scaling. */
export const PLAYLIST_COVER_MAX_SOURCE_BYTES = 12 * 1024 * 1024;

/** Stored (and rendered) cover edge in px — enough for a 2x playlist header. */
const COVER_SIZE = 512;

export class PlaylistCoverError extends Error {
  constructor(public readonly code: "unsupported" | "too_large" | "decode_failed") {
    super(code);
    this.name = "PlaylistCoverError";
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new PlaylistCoverError("decode_failed"));
    image.src = src;
  });
}

/**
 * Reads a user-picked image, center-crops it to a square and re-encodes it as
 * a JPEG data URL small enough to persist in localStorage (a few dozen KB
 * instead of the multi-MB original). Works in every WebView we ship.
 */
export async function fileToPlaylistCover(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new PlaylistCoverError("unsupported");
  }
  if (file.size > PLAYLIST_COVER_MAX_SOURCE_BYTES) {
    throw new PlaylistCoverError("too_large");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new PlaylistCoverError("decode_failed");

    const canvas = document.createElement("canvas");
    canvas.width = COVER_SIZE;
    canvas.height = COVER_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new PlaylistCoverError("decode_failed");

    const side = Math.min(width, height);
    const sourceX = (width - side) / 2;
    const sourceY = (height - side) / 2;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, sourceX, sourceY, side, side, 0, 0, COVER_SIZE, COVER_SIZE);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    if (!dataUrl.startsWith("data:image/")) {
      throw new PlaylistCoverError("decode_failed");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
