// services/server/scripts/verify-redis-op-timeout.mjs
// Operator acceptance for the Server Redis op-timeout fix. Run from anywhere
// that has the redis package installed and dist built (the imports below
// resolve relative to THIS FILE, so the dist path is ../dist):
//   cd services/server && node scripts/verify-redis-op-timeout.mjs
// In the runtime image it is at /app/scripts/verify-redis-op-timeout.mjs and
// reads dist at /app/dist, e.g.:
//   kubectl exec -n ceo deployment/ceo-server -c ceo-server -- \
//     node /app/scripts/verify-redis-op-timeout.mjs
//
// Scenario (same as the 77e3f0f repro): a real node-redis client whose server
// answers the handshake but never replies to the target GET. Verdict PASS:
// the server received the target GET, the runner rejected with
// QUEUE_UNAVAILABLE whose message says the command timed out, and the
// rejection arrived between 200 and 1000 ms at opTimeoutMs=250. The 77e3f0f
// image instead hung past 1500 ms on this scenario.
import net from "node:net";
import { createClient } from "redis";
import { createRedisRunnerFromClient, StoreError } from "../dist/jobs/redis-store.js";

const OP_TIMEOUT_MS = 250;
const HARD_LIMIT_MS = 1500;
const READY_TIMEOUT_MS = 3000;
const WATCHDOG_MS = 8000;
const TARGET_KEY = "op-timeout-acceptance";

const result = {
  verdict: "FAIL",
  ceo_build_sha: process.env.CEO_BUILD_SHA ?? "unknown",
  command_received: false,
  elapsed_ms: null,
  error_code: null,
  reason: null,
};

// Overall watchdog: if anything below wedges (bad init, stuck cleanup, broken
// deadline), print a FAIL record and exit instead of holding the terminal.
const watchdog = setTimeout(() => {
  result.reason = `watchdog fired after ${WATCHDOG_MS} ms`;
  console.log(JSON.stringify(result));
  process.exit(1);
}, WATCHDOG_MS);

function waitFor(cond, timeoutMs, stepMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

// RESP2 parser for the client -> server byte stream; returns leftover bytes.
function parseCommands(buf) {
  const commands = [];
  let rest = buf;
  for (;;) {
    if (rest.length === 0 || rest[0] !== 0x2a) break; // '*'
    const nl = rest.indexOf("\r\n");
    if (nl < 0) break;
    const argCount = Number.parseInt(rest.subarray(1, nl).toString("utf8"), 10);
    if (Number.isNaN(argCount)) break;
    let pos = nl + 2;
    const args = [];
    let incomplete = false;
    for (let i = 0; i < argCount; i++) {
      if (rest[pos] !== 0x24) {
        incomplete = true; // '$' — stream desynced/incomplete
        break;
      }
      const lenNl = rest.indexOf("\r\n", pos);
      if (lenNl < 0) {
        incomplete = true;
        break;
      }
      const len = Number.parseInt(rest.subarray(pos + 1, lenNl).toString("utf8"), 10);
      if (Number.isNaN(len)) {
        incomplete = true;
        break;
      }
      const start = lenNl + 2;
      const end = start + len;
      if (rest.length < end + 2) {
        incomplete = true;
        break;
      }
      args.push(rest.subarray(start, end).toString("utf8"));
      pos = end + 2;
    }
    if (incomplete) return { rest, commands };
    commands.push(args);
    rest = rest.subarray(pos);
  }
  return { rest, commands };
}

function encodeReply(command) {
  const upper = (command[0] ?? "").toUpperCase();
  if (upper === "PING") return Buffer.from("+PONG\r\n", "utf8");
  if (upper === "CLIENT") return Buffer.from("+OK\r\n", "utf8"); // handshake SETINFO
  if (upper === "SET") return Buffer.from("+OK\r\n", "utf8");
  return Buffer.from("-ERR unknown command\r\n", "utf8");
}

const sockets = new Set();
let server;
let runner;
try {
  // Fake server: answers the handshake, records and HOLDS the target GET.
  server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseCommands(buffer);
      buffer = parsed.rest;
      for (const command of parsed.commands) {
        const upper = (command[0] ?? "").toUpperCase();
        if (upper === "GET" && command[1] === TARGET_KEY) {
          result.command_received = true; // hold: never reply
          continue;
        }
        socket.write(encodeReply(command));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server has no TCP address");
  const url = `redis://127.0.0.1:${address.port}`;

  runner = createRedisRunnerFromClient(
    () =>
      createClient({
        url,
        socket: { reconnectStrategy: false },
        disableOfflineQueue: true,
      }),
    { opTimeoutMs: OP_TIMEOUT_MS },
  );

  let ready = false;
  try {
    await waitFor(() => runner.ready(), READY_TIMEOUT_MS);
    ready = true;
  } catch {
    result.reason = "runner never became ready";
  }

  if (ready) {
    const started = Date.now();
    const HANG = Symbol("hang");
    const attempt = (async () => {
      try {
        await runner.get(TARGET_KEY);
        return { resolved: true };
      } catch (e) {
        const code = e instanceof StoreError ? e.code : undefined;
        const message = e instanceof Error ? e.message : String(e);
        return {
          code,
          message,
          timedOut: /timed out/i.test(message),
          elapsed_ms: Date.now() - started,
        };
      }
    })();
    // Independent cap: a broken deadline must FAIL here, never hang the run.
    const cap = new Promise((resolve) => setTimeout(() => resolve(HANG), HARD_LIMIT_MS));
    const outcome = await Promise.race([attempt, cap]);
    attempt.catch(() => {}); // swallow a post-dispose rejection of a hung attempt
    if (outcome === HANG) {
      result.reason = `no rejection within ${HARD_LIMIT_MS} ms`;
    } else if (outcome.resolved) {
      result.reason = "call resolved instead of timing out";
    } else {
      result.elapsed_ms = outcome.elapsed_ms;
      result.error_code = outcome.code;
      if (!result.command_received) {
        result.reason = "target GET never reached the server";
      } else if (outcome.code !== "QUEUE_UNAVAILABLE") {
        result.reason = `unexpected error code: ${String(outcome.code)}`;
      } else if (!outcome.timedOut) {
        result.reason = `error does not indicate a command timeout: ${outcome.message}`;
      } else if (outcome.elapsed_ms < 200) {
        result.reason = `rejected too fast (${outcome.elapsed_ms} ms) - not a deadline`;
      } else if (outcome.elapsed_ms > 1000) {
        result.reason = `rejected too late (${outcome.elapsed_ms} ms)`;
      } else {
        result.verdict = "PASS";
      }
    }
  }
} finally {
  await runner?.dispose();
  if (server) {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

clearTimeout(watchdog);
console.log(JSON.stringify(result));
process.exit(result.verdict === "PASS" ? 0 : 1);
