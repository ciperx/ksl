/**
 * Domain types for the KSL tender event stream.
 *
 * Every state change in a tender is a single immutable event. The stream is
 * the only source of truth: current tender state is derived by folding events
 * in sequence order, never stored separately.
 */

export const EVENT_TYPES = [
  'listing',
  'airlock_decision',
  'bid',
  'selection',
  'award',
  'delivery',
  'review',
  'payment',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Human readable labels used by the daily report. */
export const STEP_LABELS: Readonly<Record<EventType, string>> = {
  listing: 'Listing',
  airlock_decision: 'Airlock decision',
  bid: 'Bid',
  selection: 'Selection',
  award: 'Award',
  delivery: 'Delivery',
  review: 'Review',
  payment: 'Payment',
};

export type SettlementRail = 'x402-solana' | 'x402-base';
export type AirlockDecision = 'admit' | 'refuse';
export type ReviewVerdict = 'accept' | 'reject';

export interface BaseTenderEvent {
  /** Caller supplied unique id; the journal rejects duplicates. */
  readonly id: string;
  /** UTC ISO 8601 instant, for example 2026-10-20T09:15:00Z. */
  readonly at: string;
  readonly tenderId: string;
  /** Who or what produced the event. */
  readonly actor: string;
}

export interface ListingEvent extends BaseTenderEvent {
  readonly type: 'listing';
  readonly title: string;
  /** Maximum price the buyer will pay, in USDC. */
  readonly ceilingUsdc: number;
}

export interface AirlockDecisionEvent extends BaseTenderEvent {
  readonly type: 'airlock_decision';
  readonly decision: AirlockDecision;
  readonly reason: string;
}

export interface BidEvent extends BaseTenderEvent {
  readonly type: 'bid';
  /** Stable id used by later selection, award, delivery, review and payment. */
  readonly bidId: string;
  readonly agent: string;
  readonly priceUsdc: number;
  /** Promised delivery day, YYYY-MM-DD. */
  readonly deliveryDate: string;
  readonly approach: string;
  readonly settlement: SettlementRail;
}

export interface SelectionEvent extends BaseTenderEvent {
  readonly type: 'selection';
  readonly bidId: string;
  readonly rationale: string;
}

export interface AwardEvent extends BaseTenderEvent {
  readonly type: 'award';
  readonly bidId: string;
  readonly awardUsdc: number;
}

export interface DeliveryEvent extends BaseTenderEvent {
  readonly type: 'delivery';
  readonly bidId: string;
  /** Repository, patch or artifact reference. */
  readonly artifact: string;
  readonly commit?: string;
}

export interface ReviewEvent extends BaseTenderEvent {
  readonly type: 'review';
  readonly bidId: string;
  readonly verdict: ReviewVerdict;
  readonly notes: string;
}

export interface PaymentEvent extends BaseTenderEvent {
  readonly type: 'payment';
  readonly bidId: string;
  readonly amountUsdc: number;
  readonly rail: SettlementRail;
  readonly txRef: string;
}

export type TenderEvent =
  | ListingEvent
  | AirlockDecisionEvent
  | BidEvent
  | SelectionEvent
  | AwardEvent
  | DeliveryEvent
  | ReviewEvent
  | PaymentEvent;

/** One line of the JSONL journal: event plus writer owned chain metadata. */
export interface EventRecord {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly event: TenderEvent;
}

/** Anomaly codes emitted by the report. */
export const ANOMALY_CODES = [
  'bid_without_airlock_decision',
  'bid_after_refusal',
  'bid_above_ceiling',
  'selection_without_bid',
  'award_without_selection',
  'delivery_without_award',
  'review_without_delivery',
  'payment_without_acceptance',
  'payment_exceeds_award',
  'duplicate_event_id',
  'duplicate_seq',
] as const;

export type AnomalyCode = (typeof ANOMALY_CODES)[number];

export interface Anomaly {
  readonly code: AnomalyCode;
  readonly eventId: string;
  readonly tenderId: string;
  readonly bidId?: string;
  readonly seq?: number;
  /** Position of the offending event in the stream that was folded. */
  readonly index?: number;
  readonly message: string;
}
