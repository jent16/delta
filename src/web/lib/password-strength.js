// A warning, never a rule: the server accepts any password. This only tells the person, while they type, when
// what they chose is easy to guess, so it is their informed choice. Pure, so it is tested like any other function.

const COMMON = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "123456", "1234567", "12345678", "123456789", "1234567890", "12345678910",
  "qwerty", "qwerty123", "qwertyuiop", "qwerty12345", "iloveyou", "iloveyou12", "letmein", "letmein123", "welcome", "welcome123", "admin", "admin123",
  "admin12345", "abc123", "abcdefghij", "0123456789", "111111", "000000", "1q2w3e4r", "1q2w3e4r5t", "monkey", "dragon", "football", "baseball",
]);

export const WARNING = "This password is easy to guess. Simple passwords are much more likely to be broken into, which would expose everything in your account. You can still use it, but a longer one, such as a few random words, is safer.";

/** Why this password is weak (a short reason), or null if nothing obvious is wrong. An empty box gets no warning. */
export function passwordWeakness(password, email = "") {
  if (!password) return null;
  const lowered = password.toLowerCase();
  const mail = String(email ?? "").trim().toLowerCase();
  if (COMMON.has(lowered)) return "it is one of the most common passwords";
  if (/^(.)\1+$/.test(password)) return "it is one character repeated";
  if (mail && (lowered === mail || lowered === mail.split("@")[0])) return "it is your email";
  if (/^\d+$/.test(password)) return password.length < 16 ? "it is only digits" : null;
  if (password.length < 10) return "it is short";
  return null;
}
