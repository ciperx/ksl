#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { EventJournal, AppendOnlyError, readJournal } from './journal.js';
import { reportSection } from './report.js';
import { ValidationError } from './validate.js';

const USAGE = `Usage:
  ksl-tender emit --journal <file.jsonl> --event '<json>'
  ksl-tender emit --journal <file.jsonl> --event -        (read JSON from stdin)
  ksl-tender report --journal <file.jsonl> --day YYYY-MM-DD [--out <file.md>]
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      journal: { type: 'string' },
      event: { type: 'string' },
      day: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  const journalPath = values.journal;
  if (journalPath === undefined) {
    process.stderr.write('missing --journal\n');
    return 1;
  }

  if (command === 'emit') {
    const raw = values.event;
    if (raw === undefined) {
      process.stderr.write('missing --event\n');
      return 1;
    }
    const text = raw === '-' ? await readStdin() : raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      process.stderr.write(`event is not valid JSON: ${(error as Error).message}\n`);
      return 1;
    }
    const journal = await EventJournal.open(journalPath);
    try {
      const record = await journal.emit(parsed);
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return 0;
    } finally {
      await journal.close();
    }
  }

  if (command === 'report') {
    const day = values.day;
    if (day === undefined) {
      process.stderr.write('missing --day\n');
      return 1;
    }
    const records = await readJournal(journalPath);
    const markdown = reportSection(records, day);
    if (values.out !== undefined) {
      await writeFile(values.out, markdown, 'utf8');
    } else {
      process.stdout.write(markdown);
    }
    return 0;
  }

  if (command === 'verify') {
    const records = await readJournal(journalPath);
    process.stdout.write(`${records.length} events verified\n`);
    return 0;
  }

  process.stderr.write(`unknown command ${command}\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ValidationError) {
      process.stderr.write(`invalid event: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof AppendOnlyError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
  },
);
