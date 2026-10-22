import type {
  AirlockDecision,
  ReviewVerdict,
  SettlementRail,
  TenderEvent,
  EventType,
} from './types.js';
import { EVENT_TYPES } from './types.js';

export interface ValidationIssue {
  /** JSON pointer-ish path into the supplied event. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly event: TenderEvent }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export class ValidationError extends Error {
  readonly code = 'invalid_event';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super(`invalid tender event: ${summary}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WRITER_FIELDS = ['seq', 'prevHash', 'hash'] as const;

const COMMON_KEYS = ['id', 'at', 'type', 'tenderId', 'actor'] as const;

const TYPE_KEYS: Readonly<Record<EventType, readonly string[]>> = {
  listing: ['title', 'ceilingUsdc'],
  airlock_decision: ['decision', 'reason'],
  bid: ['bidId', 'agent', 'priceUsdc', 'deliveryDate', 'approach', 'settlement'],
  selection: ['bidId', 'rationale'],
  award: ['bidId', 'awardUsdc'],
  delivery: ['bidId', 'artifact', 'commit'],
  review: ['bidId', 'verdict', 'notes'],
  payment: ['bidId', 'amountUsdc', 'rail', 'txRef'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  maxLength = 2000,
): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string') {
    issues.push({ path: `${path}.${key}`, message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({ path: `${path}.${key}`, message: 'must not be empty' });
    return undefined;
  }
  if (value.length > maxLength) {
    issues.push({ path: `${path}.${key}`, message: `must be at most ${maxLength} characters` });
    return undefined;
  }
  return value;
}

function readMoney(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): number | undefined {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path: `${path}.${key}`, message: 'must be a finite number' });
    return undefined;
  }
  if (value <= 0) {
    issues.push({ path: `${path}.${key}`, message: 'must be greater than zero' });
    return undefined;
  }
  if (value > 1_000_000_000) {
    issues.push({ path: `${path}.${key}`, message: 'must be at most 1000000000' });
    return undefined;
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-9) {
    issues.push({ path: `${path}.${key}`, message: 'must have at most two decimal places' });
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
): T | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    issues.push({
      path: `${path}.${key}`,
      message: `must be one of ${allowed.join(', ')}`,
    });
    return undefined;
  }
  return value as T;
}

function readInstant(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = readString(obj, key, path, issues, 40);
  if (value === undefined) return undefined;
  if (!UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push({
      path: `${path}.${key}`,
      message: 'must be a UTC ISO 8601 instant such as 2026-10-20T09:15:00Z',
    });
    return undefined;
  }
  return value;
}

/** Validate a YYYY-MM-DD calendar day. Exported for the report entry point. */
export function isValidDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function readDay(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = readString(obj, key, path, issues, 10);
  if (value === undefined) return undefined;
  if (!isValidDay(value)) {
    issues.push({ path: `${path}.${key}`, message: 'must be a valid YYYY-MM-DD day' });
    return undefined;
  }
  return value;
}

/**
 * Validate one tender event supplied by a caller.
 *
 * The check is strict on purpose: unknown fields are rejected so that a typo
 * cannot silently drop information from the append-only stream. Writer owned
 * chain fields (seq, prevHash, hash) are rejected here because only the journal
 * may assign them.
 */
export function validateEvent(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', message: 'event must be an object' }] };
  }

  for (const field of WRITER_FIELDS) {
    if (field in input) {
      issues.push({
        path: `$.${field}`,
        message: 'is assigned by the journal and must not be supplied',
      });
    }
  }

  const type = input['type'];
  if (!isEventType(type)) {
    issues.push({
      path: '$.type',
      message: `must be one of ${EVENT_TYPES.join(', ')}`,
    });
    return { ok: false, errors: issues };
  }

  const allowed = new Set<string>([...COMMON_KEYS, ...TYPE_KEYS[type]]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key) && !(WRITER_FIELDS as readonly string[]).includes(key)) {
      issues.push({ path: `$.${key}`, message: `is not a field of a ${type} event` });
    }
  }

  const id = readString(input, 'id', '$', issues, 128);
  const at = readInstant(input, 'at', '$', issues);
  const tenderId = readString(input, 'tenderId', '$', issues, 128);
  const actor = readString(input, 'actor', '$', issues, 128);

  // Missing values are reported through `issues`; the placeholders below only
  // let the builder assemble a full object for the success path.
  const base = {
    id: id ?? '',
    at: at ?? '',
    tenderId: tenderId ?? '',
    actor: actor ?? '',
  };

  let event: TenderEvent | undefined;

  switch (type) {
    case 'listing': {
      const title = readString(input, 'title', '$', issues, 300);
      const ceilingUsdc = readMoney(input, 'ceilingUsdc', '$', issues);
      if (title !== undefined && ceilingUsdc !== undefined) {
        event = { ...base, type, title, ceilingUsdc } as TenderEvent;
      }
      break;
    }
    case 'airlock_decision': {
      const decision = readEnum<AirlockDecision>(
        input,
        'decision',
        '$',
        ['admit', 'refuse'],
        issues,
      );
      const reason = readString(input, 'reason', '$', issues, 2000);
      if (decision !== undefined && reason !== undefined) {
        event = { ...base, type, decision, reason } as TenderEvent;
      }
      break;
    }
    case 'bid': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const agent = readString(input, 'agent', '$', issues, 128);
      const priceUsdc = readMoney(input, 'priceUsdc', '$', issues);
      const deliveryDate = readDay(input, 'deliveryDate', '$', issues);
      const approach = readString(input, 'approach', '$', issues, 4000);
      const settlement = readEnum<SettlementRail>(
        input,
        'settlement',
        '$',
        ['x402-solana', 'x402-base'],
        issues,
      );
      if (
        bidId !== undefined &&
        agent !== undefined &&
        priceUsdc !== undefined &&
        deliveryDate !== undefined &&
        approach !== undefined &&
        settlement !== undefined
      ) {
        event = {
          ...base,
          type,
          bidId,
          agent,
          priceUsdc,
          deliveryDate,
          approach,
          settlement,
        } as TenderEvent;
      }
      break;
    }
    case 'selection': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const rationale = readString(input, 'rationale', '$', issues, 4000);
      if (bidId !== undefined && rationale !== undefined) {
        event = { ...base, type, bidId, rationale } as TenderEvent;
      }
      break;
    }
    case 'award': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const awardUsdc = readMoney(input, 'awardUsdc', '$', issues);
      if (bidId !== undefined && awardUsdc !== undefined) {
        event = { ...base, type, bidId, awardUsdc } as TenderEvent;
      }
      break;
    }
    case 'delivery': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const artifact = readString(input, 'artifact', '$', issues, 2000);
      let commit: string | undefined;
      let commitInvalid = false;
      if ('commit' in input && input['commit'] !== undefined) {
        commit = readString(input, 'commit', '$', issues, 128);
        commitInvalid = commit === undefined;
      }
      if (bidId !== undefined && artifact !== undefined && !commitInvalid) {
        event = { ...base, type, bidId, artifact, ...(commit === undefined ? {} : { commit }) } as TenderEvent;
      }
      break;
    }
    case 'review': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const verdict = readEnum<ReviewVerdict>(input, 'verdict', '$', ['accept', 'reject'], issues);
      const notes = readString(input, 'notes', '$', issues, 4000);
      if (bidId !== undefined && verdict !== undefined && notes !== undefined) {
        event = { ...base, type, bidId, verdict, notes } as TenderEvent;
      }
      break;
    }
    case 'payment': {
      const bidId = readString(input, 'bidId', '$', issues, 128);
      const amountUsdc = readMoney(input, 'amountUsdc', '$', issues);
      const rail = readEnum<SettlementRail>(input, 'rail', '$', ['x402-solana', 'x402-base'], issues);
      const txRef = readString(input, 'txRef', '$', issues, 256);
      if (bidId !== undefined && amountUsdc !== undefined && rail !== undefined && txRef !== undefined) {
        event = { ...base, type, bidId, amountUsdc, rail, txRef } as TenderEvent;
      }
      break;
    }
    default: {
      const exhaustive: never = type;
      issues.push({ path: '$.type', message: `unsupported event type ${String(exhaustive)}` });
    }
  }

  if (issues.length > 0) return { ok: false, errors: issues };
  if (event === undefined) {
    return { ok: false, errors: [{ path: '$', message: 'event could not be built' }] };
  }
  return { ok: true, event };
}

/** Validate or throw. Returns the narrowed event for convenient chaining. */
export function assertValidEvent(input: unknown): TenderEvent {
  const result = validateEvent(input);
  if (!result.ok) throw new ValidationError(result.errors);
  return result.event;
}
