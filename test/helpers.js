import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventJournal, readJournal } from '../dist/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export const FIXTURE_PATH = join(here, 'fixtures', 'events.json');
export const CLI_PATH = join(here, '..', 'dist', 'cli.js');

export async function loadFixture() {
  const text = await readFile(FIXTURE_PATH, 'utf8');
  return JSON.parse(text);
}

export async function tempDir() {
  return mkdtemp(join(tmpdir(), 'ksl-tender-'));
}

export async function withJournal(fn) {
  const dir = await tempDir();
  const path = join(dir, 'events.jsonl');
  try {
    return await fn({ dir, path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Emit every fixture event into a fresh journal and return its records. */
export async function seedJournal(path) {
  const events = await loadFixture();
  const journal = await EventJournal.open(path);
  try {
    for (const event of events) await journal.emit(event);
  } finally {
    await journal.close();
  }
  return readJournal(path);
}
