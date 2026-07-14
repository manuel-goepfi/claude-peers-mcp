export const CLAIM_TTL_MS = 30_000;

export function claimCutoffIso(nowMs = Date.now()): string {
  return new Date(nowMs - CLAIM_TTL_MS).toISOString();
}
