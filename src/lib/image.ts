/**
 * Crop an image to a square and shrink it to `size` px as a small JPEG data URL,
 * so thousands of contact photos still fit comfortably in the browser database.
 */
export async function shrinkImage(src: Blob | string, size = 160): Promise<string> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    if (typeof src !== 'string') URL.revokeObjectURL(url);
  }
}

/** Shrink embedded (data:) photos in place; drop any the browser can't decode. */
export async function shrinkPhotos<T extends { photo?: string }>(items: T[]): Promise<T[]> {
  const todo = items.filter((c) => c.photo?.startsWith('data:'));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async (c) => {
        try {
          c.photo = await shrinkImage(c.photo!, 128);
        } catch {
          c.photo = undefined;
        }
      }),
    );
  }
  return items;
}
