import { collectAnomalies, type AnomalyInput } from './anomalies.js';
import { EVENT_TYPES, STEP_LABELS, type Anomaly, type EventRecord, type TenderEvent } from './types.js';
import { isValidDay, ValidationError, validateEvent } from './validate.js';

/** Either a raw event or a stored journal record. */
export type ReportInput = EventRecord | TenderEvent;

function isStoredRecord(input: ReportInput): input is EventRecord {
  const candidate = input as unknown as Record<string, unknown>;
  return (
    typeof candidate['seq'] === 'number' &&
    typeof candidate['hash'] === 'string' &&
    typeof candidate['event'] === 'object' &&
    candidate['event'] !== null
  );
}

function money(value: number): string {
  return value.toFixed(2);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function dayBounds(day: string): { start: number; end: number } {
  if (!isValidDay(day)) {
    throw new RangeError(`day must be a valid YYYY-MM-DD calendar day, received ${day}`);
  }
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + 86_400_000 };
}

/**
 * Daily report section in Markdown.
 *
 * `events` may be journal records (preferred, because they carry seq) or bare
 * events. The stream is sorted deterministically, so the same set of events
 * always produces byte-identical output regardless of input order.
 *
 * Anomalies use the state as of the end of the requested day: a later event
 * cannot make an earlier day look clean, and a report for an old day is not
 * polluted by events that had not happened yet.
 */
export function reportSection(events: readonly ReportInput[], day: string): string {
  const { start, end } = dayBounds(day);

  const stream: AnomalyInput[] = events.map((input) => {
    const event = isStoredRecord(input) ? input.event : input;
    const validation = validateEvent(event);
    if (!validation.ok) throw new ValidationError(validation.errors);
    return isStoredRecord(input)
      ? { event: validation.event, seq: input.seq }
      : { event: validation.event };
  });

  stream.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
    const atDiff = Date.parse(a.event.at) - Date.parse(b.event.at);
    if (atDiff !== 0) return atDiff;
    return a.event.id.localeCompare(b.event.id);
  });

  const history: AnomalyInput[] = [];
  stream.forEach((entry, index) => {
    if (Date.parse(entry.event.at) < end) history.push({ ...entry, index });
  });
  const dayStartIndex = history.findIndex((entry) => Date.parse(entry.event.at) >= start);
  const today = dayStartIndex === -1 ? [] : history.slice(dayStartIndex);

  const anomalies = collectAnomalies(history).filter((item) => {
    if (dayStartIndex === -1) return false;
    return (item.index ?? -1) >= dayStartIndex;
  });

  const counts = new Map<string, { events: number; tenders: Set<string> }>();
  for (const type of EVENT_TYPES) counts.set(type, { events: 0, tenders: new Set() });
  for (const entry of today) {
    const bucket = counts.get(entry.event.type);
    if (bucket === undefined) continue;
    bucket.events += 1;
    bucket.tenders.add(entry.event.tenderId);
  }

  const tenders = [...new Set(today.map((entry) => entry.event.tenderId))].sort();
  let bidValue = 0;
  let awardValue = 0;
  let paidValue = 0;
  for (const { event } of today) {
    if (event.type === 'bid') bidValue += event.priceUsdc;
    if (event.type === 'award') awardValue += event.awardUsdc;
    if (event.type === 'payment') paidValue += event.amountUsdc;
  }

  const lines: string[] = [];
  lines.push(`# Tender daily report: ${day}`, '');
  const sourceNote =
    stream.length === today.length
      ? `${stream.length} events in the stream, all on this day.`
      : `${stream.length} events in the stream, ${today.length} on this day.`;
  lines.push(sourceNote, '');

  if (today.length === 0) {
    lines.push('No tender events were recorded on this day.', '');
  }

  lines.push('## Steps', '');
  lines.push('| Step | Events | Tenders |');
  lines.push('| --- | ---: | ---: |');
  for (const type of EVENT_TYPES) {
    const bucket = counts.get(type);
    if (bucket === undefined) continue;
    lines.push(`| ${STEP_LABELS[type]} | ${bucket.events} | ${bucket.tenders.size} |`);
  }
  lines.push(`| **Total** | **${today.length}** | **${tenders.length}** |`, '');

  lines.push('## Money (USDC)', '');
  lines.push(`- Bid value: ${money(bidValue)}`);
  lines.push(`- Awarded: ${money(awardValue)}`);
  lines.push(`- Paid: ${money(paidValue)}`, '');

  lines.push('## Tenders', '');
  lines.push(tenders.length === 0 ? 'None.' : tenders.map((id) => `- ${id}`).join('\n'), '');

  lines.push('## Anomalies', '');
  if (anomalies.length === 0) {
    lines.push('No anomalies.', '');
  } else {
    lines.push('| Seq | Code | Tender | Bid | Detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of anomalies) {
      lines.push(
        `| ${item.seq === undefined ? '-' : item.seq} | ${item.code} | ${escapeCell(item.tenderId)} | ${escapeCell(item.bidId ?? '-')} | ${escapeCell(item.message)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Count anomalies by code, useful for alerting on top of the report. */
export function anomalySummary(anomalies: readonly Anomaly[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of anomalies) {
    summary[item.code] = (summary[item.code] ?? 0) + 1;
  }
  return summary;
}
