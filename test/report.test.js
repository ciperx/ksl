import test from 'node:test';
import assert from 'node:assert/strict';
import { reportSection, ValidationError } from '../dist/index.js';
import { loadFixture, seedJournal, withJournal } from './helpers.js';

const DAY_ONE = '2026-10-19';
const DAY_TWO = '2026-10-20';

test('acceptance: report counts each tender step for the day', async () => {
  const events = await loadFixture();
  const report = reportSection(events, DAY_ONE);
  assert.match(report, /^# Tender daily report: 2026-10-19$/m);
  assert.match(report, /\| Listing \| 1 \| 1 \|/);
  assert.match(report, /\| Airlock decision \| 1 \| 1 \|/);
  assert.match(report, /\| Bid \| 2 \| 1 \|/);
  assert.match(report, /\| Selection \| 1 \| 1 \|/);
  assert.match(report, /\| Award \| 1 \| 1 \|/);
  assert.match(report, /\| Delivery \| 0 \| 0 \|/);
  assert.match(report, /\| Review \| 0 \| 0 \|/);
  assert.match(report, /\| Payment \| 0 \| 0 \|/);
  assert.match(report, /\| \*\*Total\*\* \| \*\*6\*\* \| \*\*1\*\* \|/);
  assert.match(report, /12 events in the stream, 6 on this day\./);
});

test('acceptance: report lists a bid without an airlock decision', async () => {
  const events = await loadFixture();
  const report = reportSection(events, DAY_TWO);
  assert.match(report, /bid_without_airlock_decision/);
  assert.match(report, /bid has no prior airlock decision admitting the tender/);
  assert.match(report, /t-ksl-2/);
});

test('acceptance: report lists a payment without acceptance', async () => {
  const events = await loadFixture();
  const report = reportSection(events, DAY_TWO);
  assert.match(report, /payment_without_acceptance/);
  assert.match(report, /payment names bid b-3, which has no accepting review/);
  const paymentRow = report
    .split('\n')
    .find((line) => line.includes('payment_without_acceptance'));
  assert.ok(paymentRow, 'payment anomaly row must exist');
  assert.match(paymentRow, /\| b-3 \|/);
});

test('acceptance: report counts payment events and money for the day', async () => {
  const events = await loadFixture();
  const report = reportSection(events, DAY_TWO);
  assert.match(report, /\| Delivery \| 1 \| 1 \|/);
  assert.match(report, /\| Review \| 1 \| 1 \|/);
  assert.match(report, /\| Payment \| 2 \| 2 \|/);
  assert.match(report, /\| \*\*Total\*\* \| \*\*6\*\* \| \*\*2\*\* \|/);
  assert.match(report, /- Bid value: 15\.00/);
  assert.match(report, /- Awarded: 0\.00/);
  assert.match(report, /- Paid: 55\.00/);
});

test('acceptance: report flags a bid above the listing ceiling', async () => {
  const events = await loadFixture();
  const report = reportSection(events, DAY_ONE);
  assert.match(report, /bid_above_ceiling/);
  assert.match(report, /bid price 44 exceeds the listed ceiling 40/);
  assert.doesNotMatch(report, /payment_without_acceptance/);
});

test('acceptance: report keeps days separate', async () => {
  const events = await loadFixture();
  const dayTwo = reportSection(events, DAY_TWO);
  assert.doesNotMatch(dayTwo, /bid_above_ceiling/, 'day one anomaly must not leak into day two');

  const dayThree = reportSection(events, '2026-10-21');
  assert.match(dayThree, /No tender events were recorded on this day\./);
  assert.match(dayThree, /\| \*\*Total\*\* \| \*\*0\*\* \| \*\*0\*\* \|/);
  assert.match(dayThree, /No anomalies\./);
});

test('acceptance: report is deterministic whatever the input order', async () => {
  const events = await loadFixture();
  const forward = reportSection(events, DAY_TWO);
  const reversed = reportSection([...events].reverse(), DAY_TWO);
  assert.equal(reversed, forward);

  await withJournal(async ({ path }) => {
    const records = await seedJournal(path);
    const fromRecords = reportSection(records, DAY_TWO);
    assert.equal(reportSection([...records].reverse(), DAY_TWO), fromRecords);
    assert.match(fromRecords, /\| 11 \| bid_without_airlock_decision \|/, 'records carry seq');
    assert.match(forward, /\| - \| bid_without_airlock_decision \|/, 'raw events have no seq');
  });
});

test('acceptance: report rejects an invalid day and invalid events', async () => {
  const events = await loadFixture();
  assert.throws(() => reportSection(events, '2026-02-30'), RangeError);
  assert.throws(() => reportSection(events, '20-10-2026'), RangeError);
  assert.throws(
    () => reportSection([{ ...events[0], ceilingUsdc: -1 }], DAY_ONE),
    (error) => {
      assert.ok(error instanceof ValidationError);
      return true;
    },
  );
});
