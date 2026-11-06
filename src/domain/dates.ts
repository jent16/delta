// Calendar dates are plain "YYYY-MM-DD" strings (what a person means by
// "I applied on the 14th"), not timestamps — no timezone to get wrong.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  // rejects 2026-02-31, which `new Date` would quietly roll into March
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

/** Today in the user's local calendar. */
export function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const toUtc = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** Whole days from `from` to `to` (negative if `to` is earlier). Both are YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(toUtc(iso) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}
