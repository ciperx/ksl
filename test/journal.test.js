import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  EventJournal,
  AppendOnlyError,
  ValidationError,
  readJournal,
  emit,
  validateEvent,
} from '../dist/index.js';
import { loadFixture, seedJournal, withJournal } from './helpers.js';

test('acceptance: events are append only and survive a reopen', async () => {
  await withJournal(async ({ path }) => {
    const events = await loadFixture();
    const first = await EventJournal.open(path);
    const record = await first.emit(events[0]);
    assert.equal(record.seq, 1);
    assert.equal(record.prevHash, '0'.repeat(64));
    await first.close();

    const second = await EventJournal.open(path);
    assert.equal(second.length, 1, 'reopen must see the existing event');
    const next = await second.emit(events[1]);
    assert.equal(next.seq, 2);
    assert.equal(next.prevHash, record.hash, 'each record links to the previous hash');
    await second.close();

    const stored = await readJournal(path);
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((entry) => entry.event.id),
      ['ev-01', 'ev-02'],
    );

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /"seq":1/);
  });
});

test('acceptance: append only writer refuses a journal whose stored bytes changed', async () => {
  await withJournal(async ({ path }) => {
    await seedJournal(path);
    const before = await readFile(path, 'utf8');
    const tampered = before.replace('"priceUsdc":38', '"priceUsdc":1');
    assert.notEqual(tampered, before, 'fixture must contain the edited field');
    await writeFile(path, tampered, 'utf8');

    await assert.rejects(() => EventJournal.open(path), (error) => {
      assert.ok(error instanceof AppendOnlyError);
      assert.equal(error.code, 'tampered_journal');
      return true;
    });
    await assert.rejects(() => readJournal(path), /hash chain|hash check/);
  });
});

test('acceptance: emit validates events and names the failing field', async () => {
  await withJournal(async ({ path }) => {
    await seedJournal(path);
    const before = await readJournal(path);
    const journal = await EventJournal.open(path);
    try {
      await assert.rejects(
        () =>
          journal.emit({
            id: 'ev-bad',
            at: '2026-10-20T13:00:00Z',
            type: 'listing',
            tenderId: 't-ksl-1',
            actor: 'buyer:koa',
            ceilingUsdc: 10,
          }),
        (error) => {
          assert.ok(error instanceof ValidationError);
          assert.equal(error.code, 'invalid_event');
          assert.ok(error.issues.some((issue) => issue.path === '$.title'));
          return true;
        },
      );
      assert.equal(journal.length, before.length, 'a rejected event must not advance the journal');
    } finally {
      await journal.close();
    }
    const after = await readJournal(path);
    assert.equal(after.length, before.length);
    assert.equal(after[after.length - 1].hash, before[before.length - 1].hash);
  });
});

test('acceptance: callers cannot supply journal owned chain fields', () => {
  const result = validateEvent({
    id: 'ev-x',
    at: '2026-10-20T13:00:00Z',
    type: 'review',
    tenderId: 't-ksl-1',
    actor: 'reviewer:koa',
    bidId: 'b-1',
    verdict: 'accept',
    notes: 'looks fine',
    seq: 99,
    hash: 'f'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((issue) => issue.path).sort(),
    ['$.hash', '$.seq'],
  );
});

test('acceptance: duplicate event ids are refused by the writer', async () => {
  await withJournal(async ({ path }) => {
    const events = await loadFixture();
    await emit(path, events[0]);
    await assert.rejects(() => emit(path, events[0]), (error) => {
      assert.ok(error instanceof AppendOnlyError);
      assert.equal(error.code, 'duplicate_event_id');
      return true;
    });
    assert.equal((await readJournal(path)).length, 1);
  });
});
