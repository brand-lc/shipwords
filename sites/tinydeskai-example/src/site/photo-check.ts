// Photos too small for the swap are stopped before upload: Kling keeps the original face for them, the swap check then fails the job,
// and the render is paid upstream anyway. A 116 px photo kept the original person; 195 px swapped fine.
const MIN_SIDE = 160;

/** True if the photo's short side is under MIN_SIDE. Formats the browser cannot decode pass, and the server reports them. */
export async function photoTooSmall(file: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(file);
    const small = Math.min(bitmap.width, bitmap.height) < MIN_SIDE;
    bitmap.close();
    return small;
  } catch {
    return false;
  }
}
