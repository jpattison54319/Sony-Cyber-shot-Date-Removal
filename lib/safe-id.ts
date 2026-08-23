let sequence = 0;

/**
 * Returns a unique identifier for a queued photo or worker request.
 *
 * These identifiers only correlate UI rows with worker replies, so they carry
 * no security weight. `crypto.randomUUID` is unavailable in older mobile
 * WebKit and outside secure contexts, and letting it throw would abort the
 * file-selection handler before any photo reached the screen.
 */
export function createSafeId(prefix: string): string {
  const source = globalThis.crypto as Crypto | undefined;

  if (typeof source?.randomUUID === "function") {
    try {
      return `${prefix}-${source.randomUUID()}`;
    } catch {
      // Fall through to the remaining strategies.
    }
  }

  if (typeof source?.getRandomValues === "function") {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      // Fall through to the counter-based identifier.
    }
  }

  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
