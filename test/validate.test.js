import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, assertValidEvent, isValidDay, ValidationError } from '../dist/index.js';
import { loadFixture, withJournal, CLI_PATH } from './helpers.js';
import { EventJournal, readJournal } from '../dist/index.js';

const EVENT = {
  id: 'ev-v1',
  at: '2026-10-20T09:00:00Z',
  type: 'bid',
  tenderId: 't-ksl-1',
  actor: 'agent:garuda',
  bidId: 'b-9',
  agent: 'garuda',
  priceUsdc: 12.5,
  deliveryDate: '2026-10-24',
  approach: 'small tested patch',
  settlement: 'x402-base',
};

test('acceptance: validation accepts a well formed event', () => {
  const result = validateEvent(EVENT);
  assert.equal(result.ok, true);
  assert.equal(assertValidEvent(EVENT).type, 'bid');
  assert.equal(isValidDay('2026-10-24'), true);
  assert.equal(isValidDay('2026-13-01'), false);
});

test('acceptance: validation rejects non UTC timestamps and dirty money', () => {
  const cases = [
    [{ at: '2026-10-20 09:00:00' }, '$.at'],
    [{ at: '2026-10-20T09:00:00+02:00' }, '$.at'],
    [{ priceUsdc: -1 }, '$.priceUsdc'],
    [{ priceUsdc: 0 }, '$.priceUsdc'],
    [{ priceUsdc: 1.234 }, '$.priceUsdc'],
    [{ priceUsdc: '12' }, '$.priceUsdc'],
  ];
  for (const [patch, path] of cases) {
    const result = validateEvent({ ...EVENT, ...patch });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.ok(
      result.errors.some((issue) => issue.path === path),
      `expected an issue at ${path}, got ${JSON.stringify(result.errors)}`,
    );
  }
});

test('acceptance: validation rejects unknown fields and bad enums', () => {
  const typo = validateEvent({ ...EVENT, priceUSD: 12 });
  assert.equal(typo.ok, false);
  assert.ok(typo.errors.some((issue) => issue.path === '$.priceUSD'));

  const enumResult = validateEvent({ ...EVENT, settlement: 'wire' });
  assert.equal(enumResult.ok, false);
  assert.ok(enumResult.errors.some((issue) => issue.path === '$.settlement'));

  const empty = validateEvent({ ...EVENT, actor: '   ' });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((issue) => issue.path === '$.actor'));

  const badType = validateEvent({ ...EVENT, type: 'refund' });
  assert.equal(badType.ok, false);
  assert.equal(badType.errors[0].path, '$.type');
});

test('acceptance: assertValidEvent throws a ValidationError with issues', async () => {
  await withJournal(async ({ path }) => {
    const events = await loadFixture();
    assert.throws(() => assertValidEvent({ ...events[2], priceUsdc: 0 }), (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues[0].path, '$.priceUsdc');
      return true;
    });
    assert.equal((await readJournal(path)).length, 0);
  });
});

test('acceptance: concurrent emits get a gap free sequence', async () => {
  await withJournal(async ({ path }) => {
    const journal = await EventJournal.open(path);
    try {
      const jobs = [];
      for (let index = 0; index < 25; index += 1) {
        jobs.push(
          journal.emit({
            id: `ev-c-${index}`,
            at: `2026-10-20T09:00:${String(index).padStart(2, '0')}Z`,
            type: 'listing',
            tenderId: `t-c-${index}`,
            actor: 'buyer:koa',
            title: `concurrent tender ${index}`,
            ceilingUsdc: 10 + index,
          }),
        );
      }
      const records = await Promise.all(jobs);
      assert.deepEqual(
        records.map((record) => record.seq),
        Array.from({ length: 25 }, (_, index) => index + 1),
      );
    } finally {
      await journal.close();
    }
    const stored = await readJournal(path);
    assert.equal(stored.length, 25);
    assert.equal(new Set(stored.map((record) => record.hash)).size, 25);
  });
});
