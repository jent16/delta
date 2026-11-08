// Password hashing with scrypt (built into Node; deliberately slow and memory-hungry, so guessing is expensive).
//
// What is stored is one string: scrypt$N$r$p$salt$hash. The cost settings travel with the hash, so they can be
// raised later and old hashes still verify. The password itself is never stored or logged.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface PasswordHasher {
  hash(password: string): string;
  verify(password: string, stored: string): boolean;
  /** Spends the same time as a real check. Used when the account does not exist, so "no such email" is not faster than "wrong password". */
  burn(password: string): void;
}

const KEY_LENGTH = 32;
const maxmem = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024;

export function createScryptHasher(cost: { N: number; r: number; p: number } = { N: 32768, r: 8, p: 1 }): PasswordHasher {
  const derive = (password: string, salt: Buffer, N: number, r: number, p: number) => scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: maxmem(N, r) });
  const decoyHash = createHashString(cost, derive);
  return {
    hash(password) {
      const salt = randomBytes(16);
      return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${derive(password, salt, cost.N, cost.r, cost.p).toString("base64")}`;
    },
    verify(password, stored) {
      const parts = stored.split("$");
      if (parts.length !== 6 || parts[0] !== "scrypt") return false;
      const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
      const salt = Buffer.from(parts[4]!, "base64");
      const expected = Buffer.from(parts[5]!, "base64");
      if (expected.length !== KEY_LENGTH) return false;
      return timingSafeEqual(derive(password, salt, N, r, p), expected);
    },
    burn(password) {
      this.verify(password, decoyHash);
    },
  };
}

function createHashString(cost: { N: number; r: number; p: number }, derive: (pw: string, salt: Buffer, N: number, r: number, p: number) => Buffer): string {
  const salt = randomBytes(16);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${derive(randomBytes(16).toString("hex"), salt, cost.N, cost.r, cost.p).toString("base64")}`;
}
