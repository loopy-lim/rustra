#!/usr/bin/env node
// Failure-only diagnostics, not an acceptance gate. No raw report/path/environment output.
// Apple IPS schema: https://developer.apple.com/documentation/xcode/interpreting-the-json-format-of-a-crash-report
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROCESS_NAME = 'reactnativecalculator';
const MAX_ENTRIES_PER_DIRECTORY = 256;
const MAX_FILES = 20;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_REPORTS = 3;
const MAX_FRAMES = 12;
const ASI_KEYS = [
  'CoreFoundation',
  'libc',
  'libc++abi',
  'libsystem_c',
  'libc++abi.dylib',
  'libsystem_c.dylib',
];

function safeText(value) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/g, '[url]')
    .replace(/\/(?:Users|Volumes|private|tmp|var|home|Library|Applications)\/[^\s"'<>]+/g, '[path]')
    .replace(/(^|[\s"'=(])(?:\/|[A-Za-z]:\\)[^\s"'<>]+/g, '$1[path]')
    .replace(
      /["']?\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY)[A-Z0-9_]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(
      /["']?\b(?:Authorization|Proxy-Authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+[^\s"',;]+["']?/gi,
      '[redacted]',
    )
    .slice(0, 300);
}

function fields(value, keys) {
  const selected = {};
  for (const key of keys) {
    const entry = value?.[key];
    if (typeof entry === 'string') selected[key] = safeText(entry);
    else if (typeof entry === 'number' && Number.isFinite(entry)) selected[key] = entry;
  }
  return selected;
}

function frames(value, images) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_FRAMES).map((frame) => {
    const selected = fields(frame, ['imageOffset', 'symbol', 'symbolLocation']);
    const image =
      Number.isInteger(frame?.imageIndex) && frame.imageIndex >= 0
        ? images?.[frame.imageIndex]
        : undefined;
    if (typeof image?.name === 'string') selected.image = safeText(basename(image.name));
    return selected;
  });
}

function applicationInfo(value) {
  const lines = [];
  for (const source of ASI_KEYS) {
    if (!Array.isArray(value?.[source])) continue;
    for (const message of value[source]) {
      if (typeof message !== 'string') continue;
      for (const line of message.split(/\r?\n/)) {
        if (line.trim()) lines.push({ source, message: safeText(line) });
        if (lines.length === 4) return lines;
      }
    }
  }
  return lines;
}

function parseReport(text) {
  try {
    const body = JSON.parse(text);
    return body?.bug_type === undefined || String(body.bug_type) === '309' ? body : null;
  } catch {
    const newline = text.indexOf('\n');
    if (newline < 0) throw new Error('Invalid IPS');
    const metadata = JSON.parse(text.slice(0, newline));
    if (String(metadata?.bug_type) !== '309') return null;
    return JSON.parse(text.slice(newline + 1));
  }
}

function summarize(body, pid, startedAt) {
  if (body?.pid !== pid || body?.procName !== PROCESS_NAME || typeof body.captureTime !== 'string')
    return null;
  // Metadata timestamp tracks the report; captureTime is the actual occurrence time.
  if (
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z| ?[+-]\d{2}:?\d{2})$/.test(
      body.captureTime,
    )
  )
    return null;
  const captured = Date.parse(body.captureTime);
  if (!Number.isFinite(captured) || captured < startedAt) return null;
  const summary = {
    pid,
    procName: PROCESS_NAME,
    captureTime: new Date(captured).toISOString(),
    exception: fields(body.exception, ['type', 'signal', 'codes', 'subtype']),
    termination: fields(body.termination, ['namespace', 'code', 'indicator']),
  };
  if (typeof body.isSimulated === 'boolean') summary.isSimulated = body.isSimulated;
  if (Number.isInteger(body.faultingThread) && body.faultingThread >= 0) {
    const trace = frames(body.threads?.[body.faultingThread]?.frames, body.usedImages);
    if (trace) summary.faultingThread = { index: body.faultingThread, frames: trace };
  }
  const exceptionTrace = frames(body.lastExceptionBacktrace, body.usedImages);
  if (exceptionTrace) summary.lastExceptionBacktrace = exceptionTrace;
  const info = applicationInfo(body.asi);
  if (info.length) summary.applicationSpecificInformation = info;
  return summary;
}

function candidates(directories, scan) {
  const result = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = opendirSync(directory);
      let count = 0;
      for (; count < MAX_ENTRIES_PER_DIRECTORY; count++) {
        const entry = entries.readSync();
        if (!entry) break;
        scan.entriesExamined++;
        if (!entry.isFile() || !/^reactnativecalculator(?:[-_].*)?\.ips$/.test(entry.name))
          continue;
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (stat.isFile()) result.push({ path, modified: stat.mtimeMs });
      }
      if (count === MAX_ENTRIES_PER_DIRECTORY) scan.limitReached = true;
    } catch (error) {
      if (error.code !== 'ENOENT') scan.readErrors++;
    } finally {
      entries?.closeSync();
    }
  }
  return result.sort((a, b) => b.modified - a.modified);
}

function readReport(path, scan) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_REPORT_BYTES) {
      scan.oversizedFiles++;
      return null;
    }
    if (stat.size > MAX_TOTAL_BYTES - scan.bytesRead) {
      scan.limitReached = true;
      return null;
    }
    const data = Buffer.alloc(stat.size);
    let length = 0;
    while (length < data.length) {
      const read = readSync(fd, data, length, data.length - length, null);
      if (!read) break;
      length += read;
      scan.bytesRead += read;
    }
    scan.filesRead++;
    return data.subarray(0, length).toString('utf8');
  } catch {
    scan.readErrors++;
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function collectCrashSummary({ pid, startedAt, simId, reportsDirectories }) {
  const directories = reportsDirectories ?? [
    join(homedir(), 'Library/Logs/DiagnosticReports'),
    join(
      homedir(),
      'Library/Developer/CoreSimulator/Devices',
      simId,
      'data/Library/Logs/CrashReporter',
    ),
  ];
  const scan = {
    entriesExamined: 0,
    filesRead: 0,
    bytesRead: 0,
    oversizedFiles: 0,
    parseErrors: 0,
    readErrors: 0,
    limitReached: false,
  };
  const available = candidates(directories, scan);
  if (available.length > MAX_FILES) scan.limitReached = true;
  const reports = [];
  for (const entry of available.slice(0, MAX_FILES)) {
    const text = readReport(entry.path, scan);
    if (text === null) continue;
    try {
      const summary = summarize(parseReport(text), pid, startedAt);
      if (summary) reports.push(summary);
    } catch {
      scan.parseErrors++;
    }
  }
  reports.sort((a, b) => b.captureTime.localeCompare(a.captureTime));
  return {
    schemaVersion: 1,
    status: reports.length ? 'found' : 'no-report',
    pid,
    procName: PROCESS_NAME,
    startedAt: new Date(startedAt).toISOString(),
    scan,
    reports: reports.slice(0, MAX_REPORTS),
  };
}

function argumentsForCli(args) {
  const options = {},
    reportsDirectories = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!value) throw new Error('Invalid arguments');
    if (key === '--reports-dir') reportsDirectories.push(value);
    else {
      if (
        !['--pid', '--started-at', '--sim-id', '--output'].includes(key) ||
        options[key] !== undefined
      )
        throw new Error('Invalid arguments');
      options[key] = value;
    }
  }
  if (
    !/^[1-9]\d*$/.test(options['--pid'] ?? '') ||
    !/^@\d+$/.test(options['--started-at'] ?? '') ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(options['--sim-id'] ?? '') ||
    !options['--output'] ||
    !isAbsolute(options['--output']) ||
    reportsDirectories.length > 2
  )
    throw new Error('Invalid arguments');
  const pid = Number(options['--pid']),
    startedAt = Number(options['--started-at'].slice(1)) * 1000;
  if (
    !Number.isSafeInteger(pid) ||
    pid > 2147483647 ||
    !Number.isSafeInteger(startedAt) ||
    !Number.isFinite(new Date(startedAt).getTime())
  )
    throw new Error('Invalid arguments');
  return {
    pid,
    startedAt,
    simId: options['--sim-id'],
    output: options['--output'],
    reportsDirectories: reportsDirectories.length ? reportsDirectories : undefined,
  };
}

function main() {
  let options;
  try {
    options = argumentsForCli(process.argv.slice(2));
  } catch {
    console.error('Invalid iOS crash-summary arguments.');
    process.exitCode = 2;
    return;
  }
  try {
    const summary = collectCrashSummary(options);
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `iOS crash summary: ${summary.status} (${summary.reports.length} matched reports).`,
    );
  } catch {
    console.error('Unable to collect or write the iOS crash summary.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
