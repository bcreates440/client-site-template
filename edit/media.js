// Pictures: shrinking them in the browser before upload, and keeping new
// ones on this computer (IndexedDB) until they're published, so a closed tab
// never loses a picture any more than it loses words.

const MAX = 2000;      // longest side of a full-size picture, in pixels
const QUALITY = 0.82;

// "My Photo (2).JPG" -> "my-photo-2-k3x9.jpg"; the short random part keeps two
// uploads of "photo.jpg" from overwriting each other.
export function fileName(original, ext) {
  const base = original.replace(/\.[^.]+$/, "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "picture";
  return `${base}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

// Scales a picture so its longest side is at most `max`, and re-encodes it.
// Pictures with see-through parts (PNG, WebP, GIF) become WebP so they stay
// see-through; photos become JPEG.
export async function shrink(file, max = MAX) {
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) {
    throw new Error("That file isn't a picture this editor can use. Please choose a JPEG, PNG or WebP picture.");
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale), height = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
  const blob = await canvas.convertToBlob({ type, quality: QUALITY });
  return { blob, width, height, ext: type === "image/jpeg" ? "jpg" : "webp" };
}

// --- pending uploads, kept on this computer --------------------------------
const DB = "site-editor", STORE = "uploads";
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}
// key: "<repo>@<branch>" -> { [repoPath]: Blob }
export const loadUploads = (key) => tx("readonly", (s) => s.get(key)).then((v) => v ?? {}).catch(() => ({}));
export const saveUploads = (key, uploads) =>
  tx("readwrite", (s) => (Object.keys(uploads).length ? s.put(uploads, key) : s.delete(key))).catch(() => {});
