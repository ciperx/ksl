# ksl-tender-events

Append-only tender event journal and daily report section for KSL tenders.

Every tender step is one immutable event: listing, airlock decision, bid,
selection, award, delivery, review, payment. Events are validated on the way in,
chained by SHA-256 so stored bytes cannot be edited undetected, and folded into
a Markdown section for any UTC day.

The public interface is exactly the spec's two entry points:

```ts
emit(event): Promise<EventRecord>
reportSection(events, day): string
```

## Install and test

```bash
npm install
npm run typecheck     # tsc --noEmit, clean
npm test              # builds, then runs node:test (20 tests, no network)
```

Node 20 or newer, ESM only. Tests use `node:test` and fixtures; nothing touches
the network or a live chain.

## Event shapes

Common fields for every event:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique in the journal; duplicates are refused |
| `at` | string | UTC ISO 8601, for example `2026-10-20T09:15:00Z` |
| `type` | string | One of the eight steps below |
| `tenderId` | string | Tender this event belongs to |
| `actor` | string | Who or what produced the event |

Step specific fields:

| Type | Extra fields |
| --- | --- |
| `listing` | `title`, `ceilingUsdc` |
| `airlock_decision` | `decision` (`admit` or `refuse`), `reason` |
| `bid` | `bidId`, `agent`, `priceUsdc`, `deliveryDate` (`YYYY-MM-DD`), `approach`, `settlement` (`x402-solana` or `x402-base`) |
| `selection` | `bidId`, `rationale` |
| `award` | `bidId`, `awardUsdc` |
| `delivery` | `bidId`, `artifact`, optional `commit` |
| `review` | `bidId`, `verdict` (`accept` or `reject`), `notes` |
| `payment` | `bidId`, `amountUsdc`, `rail`, `txRef` |

Validation is strict: unknown fields, an unwritable price, a non-UTC timestamp
or a missing field all reject the event with a path such as `$.priceUsdc`.
`seq`, `prevHash` and `hash` belong to the journal and may not be supplied.

```ts
import { EventJournal, readJournal, reportSection } from 'ksl-tender-events';

const journal = await EventJournal.open('tenders.jsonl');

await journal.emit({
  id: 'ev-01',
  at: '2026-10-20T09:00:00Z',
  type: 'listing',
  tenderId: 't-ksl-1',
  actor: 'buyer:koa',
  title: 'Tender event journal',
  ceilingUsdc: 40,
});

await journal.emit({
  id: 'ev-02',
  at: '2026-10-20T09:30:00Z',
  type: 'airlock_decision',
  tenderId: 't-ksl-1',
  actor: 'airlock:koa',
  decision: 'admit',
  reason: 'scope and budget are clear',
});

await journal.emit({
  id: 'ev-03',
  at: '2026-10-20T10:00:00Z',
  type: 'bid',
  tenderId: 't-ksl-1',
  actor: 'agent:garuda',
  bidId: 'b-1',
  agent: 'garuda',
  priceUsdc: 38,
  deliveryDate: '2026-10-24',
  approach: 'append only journal plus a daily report',
  settlement: 'x402-base',
});

await journal.close();

const records = await readJournal('tenders.jsonl'); // verifies the hash chain
console.log(reportSection(records, '2026-10-20'));
```

For a single event there is a shorthand, equivalent to `emit(event)`:

```ts
import { emit } from 'ksl-tender-events';

await emit('tenders.jsonl', {
  id: 'ev-04',
  at: '2026-10-20T11:00:00Z',
  type: 'airlock_decision',
  tenderId: 't-ksl-1',
  actor: 'airlock:koa',
  decision: 'refuse',
  reason: 'duplicate of an earlier tender',
});
```

## Daily report

`reportSection(events, day)` takes journal records (preferred, they carry
`seq`) or bare events, plus a UTC day as `YYYY-MM-DD`. It returns Markdown:

```markdown
# Tender daily report: 2026-10-20

12 events in the stream, 6 on this day.

## Steps

| Step | Events | Tenders |
| --- | ---: | ---: |
| Listing | 1 | 1 |
| Airlock decision | 0 | 0 |
| Bid | 1 | 1 |
| Selection | 0 | 0 |
| Award | 0 | 0 |
| Delivery | 1 | 1 |
| Review | 1 | 1 |
| Payment | 2 | 2 |
| **Total** | **6** | **2** |

## Money (USDC)

- Bid value: 15.00
- Awarded: 0.00
- Paid: 55.00

## Tenders

- t-ksl-1
- t-ksl-2

## Anomalies

| Seq | Code | Tender | Bid | Detail |
| --- | --- | --- | --- | --- |
| 11 | bid_without_airlock_decision | t-ksl-2 | b-3 | bid has no prior airlock decision admitting the tender |
| 12 | payment_without_acceptance | t-ksl-2 | b-3 | payment names bid b-3, which has no accepting review |
```

Anomaly codes:

| Code | Meaning |
| --- | --- |
| `bid_without_airlock_decision` | Bid on a tender that was never admitted |
| `bid_after_refusal` | Bid while the latest airlock decision is refuse |
| `bid_above_ceiling` | Bid price above the listing ceiling |
| `selection_without_bid` | Selection names a bid unknown to the tender |
| `award_without_selection` | Award without a prior selection for that bid |
| `delivery_without_award` | Delivery without an award |
| `review_without_delivery` | Review without a delivery |
| `payment_without_acceptance` | Payment without an accepting review |
| `payment_exceeds_award` | Payments total above the awarded amount |
| `duplicate_event_id` | Same event id twice in the stream |
| `duplicate_seq` | Same journal sequence twice |

Days are UTC and half open: `[00:00:00.000Z, next day 00:00:00.000Z)`. State
from earlier days is folded in, so a bid admitted the day before is not flagged
on the day it is selected. Events after the requested day are ignored, so an
old report is stable when new events arrive. Output is sorted (by `seq` when
present, otherwise by timestamp then id), so identical input yields
byte-identical Markdown.

## Command line

```bash
node dist/cli.js emit --journal tenders.jsonl --event "$(cat event.json)"
node dist/cli.js emit --journal tenders.jsonl --event - < event.json
node dist/cli.js report --journal tenders.jsonl --day 2026-10-20
node dist/cli.js report --journal tenders.jsonl --day 2026-10-20 --out report.md
node dist/cli.js verify --journal tenders.jsonl
```

Exit codes: `0` success, `1` usage or validation error, `2` journal or I/O
error such as a broken hash chain.

## Append-only guarantees

Each line is `{"seq":n,"prevHash":"...","hash":"...","event":{...}}`.

- `hash` is SHA-256 over canonical JSON (object keys sorted) of `seq`,
  `prevHash` and `event`.
- `prevHash` equals the previous line's `hash`; line 1 uses 64 zeros.
- `seq` must be exactly one greater than the previous line.
- Opening a journal verifies every line. Any edit, reorder, deletion from the
  middle or malformed line throws `AppendOnlyError` with code
  `tampered_journal` or `malformed_line`, and the writer refuses to extend the
  file.
- There is no update or delete API. A correction is a new compensating event.
- Writes are serialised inside one process and `fsync`ed before `emit` resolves.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Invalid event | `ValidationError` with `issues[]`; nothing is written, `seq` does not advance |
| Duplicate event id | `AppendOnlyError` code `duplicate_event_id`; existing line untouched |
| Journal edited on disk | `AppendOnlyError` code `tampered_journal` on open or read; writer refuses to append |
| Malformed or blank line | `AppendOnlyError` code `malformed_line` with the line number |
| `emit` after `close` | `AppendOnlyError` code `closed` |
| Invalid report day | `RangeError`; invalid events in the array throw `ValidationError` |
| Missing journal file | Treated as empty on first open; `readJournal` returns `[]` |
| Two OS processes on one file | Not coordinated beyond `O_APPEND`; run one writer per file or hold an external lock |
| Lost tail of the file | Not detectable from the file alone; anchor the head hash somewhere external if truncation matters |
| Clock skew between writers | `at` is caller supplied and never rewritten; ordering of the stream comes from `seq`, not wall clock |

Money is USDC with at most two decimal places. This package does not sign,
settle or verify x402 payments; `txRef` is recorded as supplied and settlement
is checked outside this module.

## Layout

```
src/types.ts       event union, labels, anomaly codes
src/validate.ts    strict validation with field paths
src/canonical.ts   canonical JSON and SHA-256 link hash
src/journal.ts     append-only writer, chain verification, emit shorthand
src/anomalies.ts   state fold and anomaly rules
src/report.ts      daily Markdown section
src/cli.ts         emit, report and verify commands
test/*.test.js     node:test suites named after acceptance items
test/fixtures/     deterministic event stream, no network
```
