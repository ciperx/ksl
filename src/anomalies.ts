import type { Anomaly, AnomalyCode, TenderEvent } from './types.js';

export interface AnomalyInput {
  readonly event: TenderEvent;
  readonly seq?: number;
  readonly index?: number;
}

interface BidState {
  price: number;
  selected: boolean;
  awarded: number | undefined;
  delivered: boolean;
  accepted: boolean;
  paid: number;
}

interface TenderState {
  ceiling: number | undefined;
  admitted: boolean;
  refused: boolean;
  bids: Map<string, BidState>;
}

function tenderOf(state: Map<string, TenderState>, tenderId: string): TenderState {
  const existing = state.get(tenderId);
  if (existing !== undefined) return existing;
  const fresh: TenderState = {
    ceiling: undefined,
    admitted: false,
    refused: false,
    bids: new Map<string, BidState>(),
  };
  state.set(tenderId, fresh);
  return fresh;
}

function anomaly(
  code: AnomalyCode,
  input: AnomalyInput,
  message: string,
  bidId?: string,
): Anomaly {
  return {
    code,
    eventId: input.event.id,
    tenderId: input.event.tenderId,
    ...(bidId === undefined ? {} : { bidId }),
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    ...(input.index === undefined ? {} : { index: input.index }),
    message,
  };
}

/**
 * Walk the stream in order and report state violations.
 *
 * The fold is the tender state machine. An anomaly is recorded at the event
 * that violates the expected order; later events still update state so that one
 * root cause does not suppress the rest of the audit trail.
 *
 * Acceptance means a review with verdict `accept` for the same bid. That is why
 * a payment without such a review is flagged.
 */
export function collectAnomalies(events: readonly AnomalyInput[]): Anomaly[] {
  const tenders = new Map<string, TenderState>();
  const seenIds = new Set<string>();
  const seenSeqs = new Set<number>();
  const anomalies: Anomaly[] = [];

  for (const input of events) {
    const { event } = input;

    if (seenIds.has(event.id)) {
      anomalies.push(
        anomaly('duplicate_event_id', input, `event id ${event.id} appears more than once`),
      );
    }
    seenIds.add(event.id);

    if (input.seq !== undefined) {
      if (seenSeqs.has(input.seq)) {
        anomalies.push(anomaly('duplicate_seq', input, `seq ${input.seq} appears more than once`));
      }
      seenSeqs.add(input.seq);
    }

    const tender = tenderOf(tenders, event.tenderId);

    switch (event.type) {
      case 'listing': {
        if (tender.ceiling === undefined) tender.ceiling = event.ceilingUsdc;
        break;
      }
      case 'airlock_decision': {
        if (event.decision === 'admit') {
          tender.admitted = true;
          tender.refused = false;
        } else {
          tender.refused = true;
          tender.admitted = false;
        }
        break;
      }
      case 'bid': {
        if (!tender.admitted && !tender.refused) {
          anomalies.push(
            anomaly(
              'bid_without_airlock_decision',
              input,
              'bid has no prior airlock decision admitting the tender',
              event.bidId,
            ),
          );
        }
        if (tender.refused) {
          anomalies.push(
            anomaly(
              'bid_after_refusal',
              input,
              'bid arrived while the latest airlock decision is refuse',
              event.bidId,
            ),
          );
        }
        if (tender.ceiling !== undefined && event.priceUsdc > tender.ceiling) {
          anomalies.push(
            anomaly(
              'bid_above_ceiling',
              input,
              `bid price ${event.priceUsdc} exceeds the listed ceiling ${tender.ceiling}`,
              event.bidId,
            ),
          );
        }
        tender.bids.set(event.bidId, {
          price: event.priceUsdc,
          selected: false,
          awarded: undefined,
          delivered: false,
          accepted: false,
          paid: 0,
        });
        break;
      }
      case 'selection': {
        const bid = tender.bids.get(event.bidId);
        if (bid === undefined) {
          anomalies.push(
            anomaly(
              'selection_without_bid',
              input,
              `selection names bid ${event.bidId}, which is not in this tender`,
              event.bidId,
            ),
          );
        } else {
          bid.selected = true;
        }
        break;
      }
      case 'award': {
        const bid = tender.bids.get(event.bidId);
        if (bid === undefined) {
          anomalies.push(
            anomaly(
              'award_without_selection',
              input,
              `award names bid ${event.bidId}, which is not in this tender`,
              event.bidId,
            ),
          );
        } else if (!bid.selected) {
          anomalies.push(
            anomaly(
              'award_without_selection',
              input,
              `award names bid ${event.bidId}, which was never selected`,
              event.bidId,
            ),
          );
        } else {
          bid.awarded = event.awardUsdc;
        }
        break;
      }
      case 'delivery': {
        const bid = tender.bids.get(event.bidId);
        if (bid === undefined || bid.awarded === undefined) {
          anomalies.push(
            anomaly(
              'delivery_without_award',
              input,
              `delivery names bid ${event.bidId}, which has no award`,
              event.bidId,
            ),
          );
        } else {
          bid.delivered = true;
        }
        break;
      }
      case 'review': {
        const bid = tender.bids.get(event.bidId);
        if (bid === undefined || !bid.delivered) {
          anomalies.push(
            anomaly(
              'review_without_delivery',
              input,
              `review names bid ${event.bidId}, which has no delivery`,
              event.bidId,
            ),
          );
        }
        if (bid !== undefined && event.verdict === 'accept') bid.accepted = true;
        break;
      }
      case 'payment': {
        const bid = tender.bids.get(event.bidId);
        if (bid === undefined || !bid.accepted) {
          anomalies.push(
            anomaly(
              'payment_without_acceptance',
              input,
              `payment names bid ${event.bidId}, which has no accepting review`,
              event.bidId,
            ),
          );
        }
        if (bid !== undefined && bid.awarded !== undefined) {
          const totalPaid = bid.paid + event.amountUsdc;
          if (totalPaid > bid.awarded + 1e-9) {
            anomalies.push(
              anomaly(
                'payment_exceeds_award',
                input,
                `payments for bid ${event.bidId} total ${Number(totalPaid.toFixed(2))}, above the award ${bid.awarded}`,
                event.bidId,
              ),
            );
          }
          bid.paid = totalPaid;
        }
        break;
      }
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  return anomalies;
}
