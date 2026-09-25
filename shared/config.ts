/**
 * Default limits. The server can override them through environment variables
 * and reports the values it enforces from GET /api/config.
 */
export const DEFAULT_LIMITS = {
  /** Largest PDF accepted by upload and link import. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Largest page count the reader opens. */
  maxPages: 200,
  /** Longest selection that can be translated in one request. */
  maxSelectionChars: 6000,
} as const;

export interface Limits {
  maxFileBytes: number;
  maxPages: number;
  maxSelectionChars: number;
}

/** Bounds for the surrounding context sent with a selection. */
export const CONTEXT_LIMITS = {
  beforeChars: 1200,
  afterChars: 600,
  titleChars: 300,
  sectionChars: 200,
} as const;

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}
