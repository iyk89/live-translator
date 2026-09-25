/** SHA-256 hex digest; falls back to a 64-bit hash where WebCrypto is unavailable (non-HTTPS origins). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `h64-${hash64(bytes)}-${bytes.byteLength}`;
}

/** Fast non-cryptographic 64-bit hash (two cyrb53-style lanes) as hex. */
export function hash64(input: Uint8Array | string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  const length = typeof input === "string" ? input.length : input.byteLength;
  for (let i = 0; i < length; i++) {
    const code = typeof input === "string" ? input.charCodeAt(i) : input[i]!;
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
