import { open, mkdir, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GENESIS_HASH, recordHash } from './canonical.js';
import type { EventRecord } from './types.js';
import { ValidationError, validateEvent, type ValidationIssue } from './validate.js';

export type AppendOnlyErrorCode =
  | 'closed'
  | 'duplicate_event_id'
  | 'tampered_journal'
  | 'malformed_line'
  | 'io';

export class AppendOnlyError extends Error {
  readonly code: AppendOnlyErrorCode;
  readonly line?: number;
  readonly issues?: readonly ValidationIssue[];

  constructor(
    code: AppendOnlyErrorCode,
    message: string,
    options: { line?: number; issues?: readonly ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppendOnlyError';
    this.code = code;
    if (options.line !== undefined) this.line = options.line;
    if (options.issues !== undefined) this.issues = options.issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Parse and verify one JSONL line.
 *
 * Verification is structural and cryptographic: sequence must be the expected
 * one, prevHash must equal the previous link and hash must match a fresh hash
 * of the content. Any edit to a stored event is therefore detectable.
 */
function parseLine(
  text: string,
  lineNumber: number,
  expectedSeq: number,
  expectedPrevHash: string,
): EventRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AppendOnlyError('malformed_line', `line ${lineNumber} is not valid JSON`, {
      line: lineNumber,
      cause: error,
    });
  }
  if (!isRecord(raw)) {
    throw new AppendOnlyError('malformed_line', `line ${lineNumber} is not a JSON object`, {
      line: lineNumber,
    });
  }
  const seq = raw['seq'];
  const prevHash = raw['prevHash'];
  const hash = raw['hash'];
  const event = raw['event'];
  if (
    typeof seq !== 'number' ||
    !Number.isInteger(seq) ||
    typeof prevHash !== 'string' ||
    !HASH.test(prevHash) ||
    typeof hash !== 'string' ||
    !HASH.test(hash) ||
    !isRecord(event)
  ) {
    throw new AppendOnlyError('malformed_line', `line ${lineNumber} has an invalid record shape`, {
      line: lineNumber,
    });
  }
  if (seq !== expectedSeq) {
    throw new AppendOnlyError(
      'tampered_journal',
      `line ${lineNumber} has seq ${seq}, expected ${expectedSeq}`,
      { line: lineNumber },
    );
  }
  if (prevHash !== expectedPrevHash) {
    throw new AppendOnlyError('tampered_journal', `line ${lineNumber} breaks the hash chain`, {
      line: lineNumber,
    });
  }
  const validation = validateEvent(event);
  if (!validation.ok) {
    throw new AppendOnlyError('malformed_line', `line ${lineNumber} holds an invalid event`, {
      line: lineNumber,
      issues: validation.errors,
    });
  }
  const expectedHash = recordHash({ seq, prevHash, event: validation.event });
  if (expectedHash !== hash) {
    throw new AppendOnlyError('tampered_journal', `line ${lineNumber} fails its hash check`, {
      line: lineNumber,
    });
  }
  return { seq, prevHash, hash, event: validation.event };
}

/** Read a journal and verify every link before returning it. */
export async function readJournal(filePath: string): Promise<EventRecord[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new AppendOnlyError('io', `cannot read journal ${filePath}`, { cause: error });
  }
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records: EventRecord[] = [];
  let prevHash = GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === '') {
      throw new AppendOnlyError('malformed_line', `line ${index + 1} is blank`, {
        line: index + 1,
      });
    }
    const record = parseLine(line, index + 1, records.length + 1, prevHash);
    records.push(record);
    prevHash = record.hash;
  }
  return records;
}

/**
 * Append-only writer.
 *
 * Only `emit` may add data. There is deliberately no update or delete method:
 * correcting a mistake means appending a compensating event, which keeps the
 * history auditable.
 *
 * Concurrent calls to `emit` are serialised through an internal promise chain,
 * so two writers in the same process cannot interleave lines or reuse a seq.
 */
export class EventJournal {
  readonly path: string;
  private handle: FileHandle | undefined;
  private records: EventRecord[];
  private ids: Set<string>;
  private lastHash: string;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    filePath: string,
    handle: FileHandle,
    records: EventRecord[],
  ) {
    this.path = filePath;
    this.handle = handle;
    this.records = records;
    this.ids = new Set(records.map((record) => record.event.id));
    const last = records[records.length - 1];
    this.lastHash = last === undefined ? GENESIS_HASH : last.hash;
  }

  /**
   * Open a journal for appending. Existing content is verified first, so a
   * tampered file is refused rather than extended.
   */
  static async open(filePath: string): Promise<EventJournal> {
    const records = await readJournal(filePath);
    await mkdir(dirname(filePath), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'a');
    } catch (error) {
      throw new AppendOnlyError('io', `cannot open journal ${filePath}`, { cause: error });
    }
    return new EventJournal(filePath, handle, records);
  }

  /** Number of events stored so far. */
  get length(): number {
    return this.records.length;
  }

  /** Hash of the newest link. */
  get headHash(): string {
    return this.lastHash;
  }

  /** Snapshot of the verified records, oldest first. */
  snapshot(): readonly EventRecord[] {
    return [...this.records];
  }

  /**
   * Validate and append one event. Resolves with the stored record, which
   * carries the journal-assigned seq and hash.
   */
  emit(input: unknown): Promise<EventRecord> {
    return this.enqueue(async () => {
      if (this.closed || this.handle === undefined) {
        throw new AppendOnlyError('closed', 'journal is closed');
      }
      const validation = validateEvent(input);
      if (!validation.ok) throw new ValidationError(validation.errors);
      if (this.ids.has(validation.event.id)) {
        throw new AppendOnlyError(
          'duplicate_event_id',
          `event id ${validation.event.id} is already in the journal`,
        );
      }
      const seq = this.records.length + 1;
      const prevHash = this.lastHash;
      const hash = recordHash({ seq, prevHash, event: validation.event });
      const record: EventRecord = { seq, prevHash, hash, event: validation.event };
      const line = `${JSON.stringify(record)}\n`;
      try {
        await this.handle.appendFile(line, 'utf8');
        await this.handle.sync();
      } catch (error) {
        throw new AppendOnlyError('io', `cannot append to ${this.path}`, { cause: error });
      }
      this.records.push(record);
      this.ids.add(record.event.id);
      this.lastHash = hash;
      return record;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) await handle.close();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Convenience equivalent of `emit(event)`: opens the journal, appends one
 * event and closes it again. Use EventJournal directly for many events.
 */
export async function emit(filePath: string, input: unknown): Promise<EventRecord> {
  const journal = await EventJournal.open(filePath);
  try {
    return await journal.emit(input);
  } finally {
    await journal.close();
  }
}

/** Returns a bound emit function for a single journal path. */
export function createEmitter(filePath: string): (input: unknown) => Promise<EventRecord> {
  return (input: unknown) => emit(filePath, input);
}
