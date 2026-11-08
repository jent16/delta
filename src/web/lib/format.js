// Dates. The server speaks plain "YYYY-MM-DD" days; these helpers never involve a time of day,
// so there is no timezone or daylight-saving trap (everything is computed at noon UTC).

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n) => String(n).padStart(2, "0");
const utc = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d, 12); };

/** Today on the viewer's own calendar. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export const addDays = (iso, n) => new Date(utc(iso) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY);
/** The Monday of the week containing `iso`. */
export const weekStart = (iso) => addDays(iso, -((new Date(utc(iso)).getUTCDay() + 6) % 7));

export const shortDate = (iso) => { const d = new Date(utc(iso)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export function longToday(iso) { const d = new Date(utc(iso)); return `${WEEKDAYS[d.getUTCDay()]}, ${FULL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; }

/** "Today", "Yesterday", "5d ago", "3w ago" — how long ago a date was. */
export function ago(iso, now) {
  const n = daysBetween(iso, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  return n < 30 ? `${n}d ago` : `${Math.round(n / 7)}w ago`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
