/**
 * Exercise the host over a real pipe, without Chrome (plan section 63).
 *
 * Spawns the host in messaging mode and does a genuine length-prefixed
 * round-trip, so it tests the thing that actually breaks in the field - the
 * framing, and whether anything polluted stdout - rather than calling the
 * dispatcher directly the way the unit tests do.
 *
 *   pnpm host:probe                 PING then GET_STATUS
 *   pnpm host:probe PING PING       repeat a message
 *   pnpm host:probe --bad           send a malformed message
 *   pnpm host:probe --batch         send two messages in a single write
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeFrame } from '../apps/native-host/src/messaging/framing.ts';

const HOST = fileURLToPath(new URL('../apps/native-host/src/main.ts', import.meta.url));

const argv = process.argv.slice(2);
const bad = argv.includes('--bad');
const batch = argv.includes('--batch');
const types = argv.filter((argument) => !argument.startsWith('--'));
const messages =
  types.length > 0 ? types : bad ? [] : ['PING', 'GET_STATUS'];

const child = spawn(process.execPath, ['--import', 'tsx', HOST], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const reader = createFrameReader();
let received = 0;
let expected = messages.length + (bad ? 1 : 0);

child.stdout.on('data', (chunk: Buffer) => {
  for (const frame of reader.push(chunk)) {
    received++;
    if (frame.ok) {
      process.stdout.write(`${JSON.stringify(frame.value, null, 2)}\n`);
    } else {
      process.stdout.write(`FRAME ERROR ${frame.reason}\n`);
    }
  }
  if (received >= expected) child.stdin.end();
});

child.on('close', (code) => {
  process.stderr.write(
    `\nhost exited with ${code}; ${received}/${expected} response(s) received\n`,
  );
  process.exitCode = received === expected && code === 0 ? 0 : 1;
});

const frames = messages.map((type, index) =>
  encodeFrame({ id: `probe-${index + 1}`, type }),
);
if (bad) frames.push(encodeFrame({ id: 'probe-bad', type: 'DROP_TABLES' }));

if (batch) {
  // One write carrying several frames: the reader must split them, and any
  // chunk-boundary assumption in it shows up here.
  child.stdin.write(Buffer.concat(frames));
} else {
  for (const frame of frames) child.stdin.write(frame);
}

if (expected === 0) {
  expected = 1;
  child.stdin.end();
}
