const LOG_PREFIX = '[RustraReloadStress]';
const DEFAULT_BUNDLE_ID = 'com.alt-shifted.react-native-calculator';

function readFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function run(command, args) {
  const result = Bun.spawnSync({ cmd: [command, ...args], stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const error = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${error}`);
  }
}

async function requestReload(url) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('Metro message socket did not open'));
    }, 5_000);
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Metro message socket failed'));
    });
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({ method: 'reload', version: 2 }));
      setTimeout(() => {
        socket.close();
        resolve();
      }, 50);
    });
  });
}

export async function main(argv = Bun.argv.slice(2)) {
  const cycles = positiveInteger(readFlag(argv, '--cycles', '30'), '--cycles');
  const timeoutMs = positiveInteger(readFlag(argv, '--timeout-ms', '180000'), '--timeout-ms');
  const device = readFlag(argv, '--device', 'booted');
  const bundleId = readFlag(argv, '--bundle-id', DEFAULT_BUNDLE_ID);
  const reloadUrl = readFlag(argv, '--reload-url', 'ws://127.0.0.1:8081/message');

  const logProcess = Bun.spawn({
    cmd: [
      'xcrun',
      'simctl',
      'spawn',
      device,
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'debug',
      '--predicate',
      `eventMessage CONTAINS "${LOG_PREFIX}"`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const buffers = new Set();
  const ready = new Set();
  const pending = new Set();
  const reloaded = new Set();
  let settled = false;
  let lineBuffer = '';

  const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `reload stress timed out after ${timeoutMs}ms (${ready.size}/${cycles + 1} runtimes)`,
          ),
        ),
      timeoutMs,
    );

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const pass = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const maybeAdvance = async (token) => {
      if (!buffers.has(token) || !ready.has(token) || !pending.has(token) || reloaded.has(token)) {
        return;
      }
      if (ready.size === cycles + 1) {
        pass();
        return;
      }
      if (ready.size > cycles + 1) {
        fail(new Error(`received too many runtime tokens: ${ready.size}`));
        return;
      }
      reloaded.add(token);
      try {
        await requestReload(reloadUrl);
        console.log(`reload ${reloaded.size}/${cycles} requested after token=${token}`);
      } catch (error) {
        fail(error);
      }
    };

    const handleLine = (line) => {
      if (!line.includes(LOG_PREFIX)) return;
      const failed = line.match(/FAILED token=(\d+) message=(.*)$/);
      if (failed) {
        fail(new Error(`runtime ${failed[1]} failed: ${failed[2]}`));
        return;
      }
      const bufferMatch = line.match(/BUFFER_READY token=(\d+) bytes=(\d+)/);
      if (bufferMatch) {
        if (bufferMatch[2] !== '65536')
          fail(new Error(`unexpected buffer size: ${bufferMatch[2]}`));
        buffers.add(bufferMatch[1]);
        void maybeAdvance(bufferMatch[1]);
      }
      const readyMatch = line.match(/READY token=(\d+) value=100/);
      if (readyMatch) {
        ready.add(readyMatch[1]);
        console.log(`runtime ${ready.size}/${cycles + 1} ready token=${readyMatch[1]}`);
        void maybeAdvance(readyMatch[1]);
      }
      const pendingMatch = line.match(/PENDING token=(\d+)/);
      if (pendingMatch) {
        pending.add(pendingMatch[1]);
        void maybeAdvance(pendingMatch[1]);
      }
    };

    void (async () => {
      try {
        const decoder = new TextDecoder();
        for await (const chunk of logProcess.stdout) {
          lineBuffer += decoder.decode(chunk, { stream: true });
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
          if (settled) break;
        }
        if (!settled)
          fail(new Error('simulator log stream ended before the stress test completed'));
      } catch (error) {
        fail(error);
      }
    })();
  });

  try {
    await Bun.sleep(500);
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', device, bundleId]);
    await completion;
    console.log(`RN reload stress passed: ${cycles}/${cycles}`);
  } finally {
    logProcess.kill();
    await logProcess.exited;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
