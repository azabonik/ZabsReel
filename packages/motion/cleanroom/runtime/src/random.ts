// Seeded pseudorandom numbers (SPEC section 9). The hash below is this runtime's own; it is
// deterministic but does not reproduce any other library's numbers.

import { describeValue, misuse } from "./errors";

export type RandomSeed = number | string | null;

function scramble(x: number): number {
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return x >>> 0;
}

function hashKey(key: string, lane: number): number {
  let h = scramble(0x6a09e667 ^ lane);
  for (let i = 0; i < key.length; i++) {
    h = scramble((h ^ key.charCodeAt(i)) + i + lane);
  }
  return scramble(h ^ key.length);
}

/** Maps a key to a number in [0, 1) using 53 bits from two independent hash lanes. */
function unitFromKey(key: string): number {
  const high = hashKey(key, 0x1b873593);
  const low = hashKey(key, 0x5bd1e995) >>> 11;
  return (high * 2 ** 21 + low) / 2 ** 53;
}

function seedKey(seed: number | string): string {
  // Numbers and strings get different prefixes, so random(1) and random("1") differ.
  return typeof seed === "number" ? `#${String(seed)}` : `$${seed}`;
}

/** Builds random(). `onNull` runs on every random(null) call (used for the host warning). */
export function makeRandom(onNull?: () => void): (seed: RandomSeed) => number {
  return function random(seed: RandomSeed): number {
    if (seed === null) {
      onNull?.();
      return Math.random();
    }
    if (typeof seed === "number") {
      if (!Number.isFinite(seed)) {
        throw misuse(
          `random() got the seed ${String(seed)}. Number seeds must be finite; check the arithmetic that builds the seed.`,
        );
      }
      return unitFromKey(seedKey(seed));
    }
    if (typeof seed === "string") return unitFromKey(seedKey(seed));
    throw misuse(
      `random() needs a seed that is a number or a string (or null for a value that changes on every call), but got ${describeValue(seed)}.`,
    );
  };
}

/** The host-independent random() that index.ts exports. random(null) logs nothing here. */
export const random = makeRandom();

const warnedHosts = new WeakSet<object>();

/** random() for one host: the first random(null) call logs a warning through host.log. */
export function makeHostRandom(host: { log(text: string): void }): (seed: RandomSeed) => number {
  return makeRandom(() => {
    if (warnedHosts.has(host)) return;
    warnedHosts.add(host);
    host.log(
      "random(null) was called: it returns a different value every time, so frames that use it are not reproducible. Pass a number or string seed to get stable values.",
    );
  });
}
