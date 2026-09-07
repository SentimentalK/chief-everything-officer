import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import { createClient } from "redis";
import { createRedisRunnerFromClient, StoreError } from "../src/jobs/redis-store.js";
import type { RedisRunner } from "../src/jobs/redis-store.js";

// Real node-redis client + a local TCP server that speaks just enough RESP to
// hold a connection. The server ALWAYS answers the handshake (node-redis sends
// CLIENT SETINFO during connect), then applies a per-connection policy to
// business commands: reply immediately, reply after a delay (attempting the
// delivery even if the client already tore the socket down), or never reply.
// This reproduces a server that swallows commands while keeping connect/ready
// working, which is exactly what a production hang looks like from the runner.

const OP_MS = 200;

/** ms delay for a reply; Infinity = never reply (swallow). */
type ReplyPolicy = (index: number, command: string[]) => number;

interface FakeRedis {
  url: string;
  connectionCount(): number;
  /** every parsed command per connection index, including handshake commands */
  commands(index: number): string[][];
  /** whether the server observed the socket for a connection close */
  wasClosed(index: number): boolean;
  /** replies whose delivery was genuinely attempted after a delay */
  delayedAttempts(): number;
  close(): Promise<void>;
}

// RESP2 parser for the client -> server byte stream; returns leftover bytes.
function parseCommands(buf: Buffer): { rest: Buffer; commands: string[][] } {
  const commands: string[][] = [];
  let rest = buf;
  for (;;) {
    if (rest.length === 0 || rest[0] !== 0x2a) break; // '*'
    const nl = rest.indexOf("\r\n");
    if (nl < 0) break;
    const argCount = Number.parseInt(rest.subarray(1, nl).toString("utf8"), 10);
    if (Number.isNaN(argCount)) break;
    let pos = nl + 2;
    const args: string[] = [];
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

function encodeReply(command: string[]): Buffer {
  const [verb, ...rest] = command;
  const upper = (verb ?? "").toUpperCase();
  if (upper === "PING") return Buffer.from("+PONG\r\n", "utf8");
  if (upper === "CLIENT") return Buffer.from("+OK\r\n", "utf8"); // handshake SETINFO
  if (upper === "SET") return Buffer.from("+OK\r\n", "utf8");
  if (upper === "GET") {
    const value = `v:${rest[0] ?? ""}`;
    const body = Buffer.from(value, "utf8");
    return Buffer.concat([
      Buffer.from(`$${body.length}\r\n`, "utf8"),
      body,
      Buffer.from("\r\n", "utf8"),
    ]);
  }
  return Buffer.from("-ERR unknown command\r\n", "utf8");
}

function startFakeRedis(policy: ReplyPolicy = () => 0): Promise<FakeRedis> {
  let connIndex = -1;
  let connections = 0;
  let late = 0;
  const received: string[][][] = [];
  const closed = new Set<number>();
  const sockets = new Set<net.Socket>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const server = net.createServer((socket) => {
    connections++;
    connIndex++;
    const index = connIndex;
    received[index] = [];
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseCommands(buffer);
      buffer = parsed.rest;
      for (const command of parsed.commands) {
        received[index].push(command);
        const delayMs = policy(index, command);
        if (Number.isFinite(delayMs) && delayMs > 0) {
          // Genuinely attempt a delayed delivery on the SAME socket, even if
          // the runner already destroyed it (late-reply test). The attempt is
          // recorded when write is CALLED, not on success; write failures on a
          // closed socket surface via the socket 'error' listener below.
          const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            late++;
            socket.write(encodeReply(command), () => {
              /* delivery outcome observed via 'error'/'close'; nothing to do */
            });
          }, delayMs);
          pendingTimers.add(timer);
        } else if (!Number.isFinite(delayMs)) {
          // swallowed forever (held command): no reply, no timer
        } else {
          socket.write(encodeReply(command));
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      closed.add(index);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({
          url: `redis://127.0.0.1:${address.port}`,
          connectionCount: () => connections,
          commands: (i: number) => received[i] ?? [],
          wasClosed: (i: number) => closed.has(i),
          delayedAttempts: () => late,
          close: async () => {
            for (const timer of pendingTimers) clearTimeout(timer);
            pendingTimers.clear();
            for (const s of sockets) s.destroy();
            await new Promise<void>((r) => server.close(() => r()));
          },
        });
      }
    });
  });
}

function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 20): Promise<void> {
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

function errorOf<T>(p: Promise<T>): Promise<StoreError> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => {
      if (!(e instanceof StoreError)) {
        throw new Error(`expected StoreError rejection, got: ${String(e)}`);
      }
      return e;
    },
  );
}

const hangBusiness = (indices: number[]) => (index: number, command: string[]) =>
  indices.includes(index) && (command[0] === "GET" || command[0] === "SET") ? Infinity : 0;

describe("createRedisRunnerFromClient deadline (real client, local TCP)", () => {
  type Runner = RedisRunner & { dispose(): Promise<void> };
  let fake: FakeRedis | undefined;
  let runner: Runner | undefined;

  afterEach(async () => {
    await runner?.dispose();
    runner = undefined;
    await fake?.close();
    fake = undefined;
  });

  async function startRunner(server: FakeRedis): Promise<void> {
    runner = createRedisRunnerFromClient(
      () =>
        createClient({
          url: server.url,
          socket: { reconnectStrategy: false },
          disableOfflineQueue: true,
        }),
      { opTimeoutMs: OP_MS },
    );
    await waitFor(() => runner!.ready(), 3000);
  }

  it("times out a real command the server received but never answered (deadline is independent of the client)", async () => {
    fake = await startFakeRedis(hangBusiness([0]));
    await startRunner(fake);
    const started = Date.now();
    const err = await errorOf(runner!.get("k"));
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("QUEUE_UNAVAILABLE");
    expect(err.message).toMatch(/Redis command timed out/i);
    expect(err.message).toMatch(/retry with the original request_id/i);
    expect(err.message).toMatch(/outcome may be unknown/i);
    expect(elapsed).toBeGreaterThanOrEqual(OP_MS - 50);
    expect(elapsed).toBeLessThan(2000);
    const received = fake.commands(0);
    // Handshake was answered (runner became ready) before the business GET.
    const firstClient = received.findIndex((c) => c[0] === "CLIENT");
    const firstGet = received.findIndex((c) => c[0] === "GET" && c[1] === "k");
    expect(firstClient).toBeGreaterThanOrEqual(0);
    expect(firstGet).toBeGreaterThan(firstClient);
    expect(received.filter((c) => c[0] === "GET" && c[1] === "k")).toHaveLength(1);
  });

  it("reports unknown outcome on a hung write and asks to retry with the original request_id", async () => {
    fake = await startFakeRedis(hangBusiness([0]));
    await startRunner(fake);
    const err = await errorOf(runner!.set("k", "v"));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("QUEUE_UNAVAILABLE");
    expect(err.message).toMatch(/retry with the original request_id/i);
    expect(fake.commands(0).some((c) => c[0] === "SET" && c[1] === "k" && c[2] === "v")).toBe(true);
  });

  it("fails ALL concurrent in-flight commands with QUEUE_UNAVAILABLE, never hanging or cross-assigning", async () => {
    fake = await startFakeRedis(hangBusiness([0]));
    await startRunner(fake);
    const p1 = runner!.get("a");
    await new Promise((r) => setTimeout(r, 40)); // both written before the deadline
    const p2 = runner!.get("b");
    const started = Date.now();
    const [e1, e2] = await Promise.all([errorOf(p1), errorOf(p2)]);
    const elapsed = Date.now() - started;
    // Every affected request gets the explicit code — not merely "some error".
    expect(e1).toBeInstanceOf(StoreError);
    expect(e1.code).toBe("QUEUE_UNAVAILABLE");
    expect(e2).toBeInstanceOf(StoreError);
    expect(e2.code).toBe("QUEUE_UNAVAILABLE");
    expect(e1.message).toMatch(/Redis command timed out/i);
    expect(e2.message).toMatch(/retry with the original request_id/i);
    expect(elapsed).toBeLessThan(2000);
    const gets = fake.commands(0).filter((c) => c[0] === "GET");
    expect(gets.map((c) => c[1])).toEqual(["a", "b"]);
    // Connection 0 never answered; nothing may have resolved to a value.
    await new Promise((r) => setTimeout(r, OP_MS)); // no late flip
    await expect(p1).rejects.toBeInstanceOf(StoreError);
    await expect(p2).rejects.toBeInstanceOf(StoreError);
  });

  it("recovers TWICE: A times out -> B recovers -> B times out -> C recovers (second reset must work)", async () => {
    fake = await startFakeRedis(hangBusiness([0, 1])); // conns 0 and 1 hang; 2+ reply
    await startRunner(fake);

    // First timeout on connection 0, reset -> connection 1.
    const e1 = await errorOf(runner!.get("a"));
    expect(e1.code).toBe("QUEUE_UNAVAILABLE");
    expect(e1.message).toMatch(/Redis command timed out/i);
    await waitFor(() => fake!.connectionCount() >= 2 && runner!.ready(), 3000);
    expect(fake.commands(0).some((c) => c[0] === "GET" && c[1] === "a")).toBe(true);

    // Second timeout on connection 1 MUST also reset (a single-flight/locked
    // reset would make this a permanent no-op). Reset -> connection 2.
    const e2 = await errorOf(runner!.get("b"));
    expect(e2).toBeInstanceOf(StoreError);
    expect(e2.code).toBe("QUEUE_UNAVAILABLE");
    expect(e2.message).toMatch(/Redis command timed out/i);
    await waitFor(() => fake!.connectionCount() >= 3 && runner!.ready(), 3000);
    expect(fake.commands(1).some((c) => c[0] === "GET" && c[1] === "b")).toBe(true);

    // Connection 2 answers: fresh connection fully recovers.
    const value = await runner!.get("c");
    expect(value).toBe("v:c");
    expect(fake.commands(2).some((c) => c[0] === "GET" && c[1] === "c")).toBe(true);
    expect(fake.connectionCount()).toBe(3);
    await new Promise((r) => setTimeout(r, 2 * OP_MS)); // stable: no further resets
    expect(fake.connectionCount()).toBe(3);
    expect(runner!.ready()).toBe(true);
  });

  it("a genuinely attempted late reply on the torn-down connection never resurrects the old call", async () => {
    // Connection 0 answers GET only after 600 ms (> OP_MS): the runner times
    // out at OP_MS and destroys connection 0; the server still attempts the
    // delayed write on that same socket afterwards (recorded, never silent).
    fake = await startFakeRedis((index, command) =>
      index === 0 && command[0] === "GET" ? 600 : 0,
    );
    await startRunner(fake);
    const err = await errorOf(runner!.get("pre"));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("QUEUE_UNAVAILABLE");
    expect(err.message).toMatch(/Redis command timed out/i);

    // The old connection was actually closed by the runner's teardown.
    await waitFor(() => fake!.wasClosed(0), 2000);

    // New connection recovers and serves its own command with the right value.
    await waitFor(() => fake!.connectionCount() >= 2 && runner!.ready(), 3000);
    const value = await runner!.get("post");
    expect(value).toBe("v:post");
    expect(fake.commands(1).some((c) => c[0] === "GET" && c[1] === "post")).toBe(true);
    expect(fake.commands(0).filter((c) => c[0] === "GET").map((c) => c[1])).toEqual(["pre"]);

    // Wait until the server genuinely attempted the late write (>= 600 ms),
    // then beyond: the old call stays rejected, no late value surfaces, and no
    // third connection appears.
    await waitFor(() => fake!.delayedAttempts() >= 1, 2000);
    await new Promise((r) => setTimeout(r, OP_MS));
    expect(err.code).toBe("QUEUE_UNAVAILABLE");
    expect(fake.connectionCount()).toBe(2);
  });

  it("dispose() with an outstanding command rejects it, then never spawns a new connection past the deadline", async () => {
    fake = await startFakeRedis(hangBusiness([0]));
    await startRunner(fake);
    const pending = runner!.get("k"); // hangs on connection 0
    await new Promise((r) => setTimeout(r, 40)); // command written, deadline not hit
    await runner!.dispose();
    const err = await errorOf(pending);
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("QUEUE_UNAVAILABLE");
    expect(runner!.ready()).toBe(false);
    // Ops after dispose fail explicitly and immediately.
    await expect(runner!.get("x")).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    // Wait far past the original command deadline: the stale timeout callback
    // must not re-create a connection (disposed guard).
    await new Promise((r) => setTimeout(r, 3 * OP_MS));
    expect(fake.connectionCount()).toBe(1);
    // Double dispose is safe.
    await runner!.dispose();
    expect(fake.connectionCount()).toBe(1);
  });
});
