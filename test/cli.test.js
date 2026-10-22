import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadFixture, withJournal, CLI_PATH } from './helpers.js';

const run = promisify(execFile);

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('acceptance: cli emits events and prints the daily report', async () => {
  await withJournal(async ({ path }) => {
    const events = await loadFixture();
    for (const event of events) {
      const result = await cli(['emit', '--journal', path, '--event', JSON.stringify(event)]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /"seq":/);
    }

    const verify = await cli(['verify', '--journal', path]);
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, /12 events verified/);

    const report = await cli(['report', '--journal', path, '--day', '2026-10-20']);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /# Tender daily report: 2026-10-20/);
    assert.match(report.stdout, /payment_without_acceptance/);
  });
});

test('acceptance: cli reports a validation failure without appending', async () => {
  await withJournal(async ({ path }) => {
    const bad = await cli(['emit', '--journal', path, '--event', '{"id":"x"}']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid event/);

    const notJson = await cli(['emit', '--journal', path, '--event', '{nope']);
    assert.equal(notJson.code, 1);
    assert.match(notJson.stderr, /not valid JSON/);

    const verify = await cli(['verify', '--journal', path]);
    assert.equal(verify.code, 0, verify.stderr);
    assert.match(verify.stdout, /0 events verified/);
  });
});
