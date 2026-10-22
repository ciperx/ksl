import { createHash } from 'node:crypto';
import type { TenderEvent } from './types.js';

/** Hash that starts the chain, used as prevHash of sequence 1. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON: object keys sorted at every level, array order kept.
 * The hash must not depend on key insertion order, or a rewritten line could
 * look valid merely because the writer reordered fields.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',');
  return `{${body}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface HashInput {
  readonly seq: number;
  readonly prevHash: string;
  readonly event: TenderEvent;
}

/** Hash of one journal link: sequence number, previous hash and the event. */
export function recordHash(input: HashInput): string {
  return sha256Hex(
    canonicalJson({
      seq: input.seq,
      prevHash: input.prevHash,
      event: input.event,
    }),
  );
}
