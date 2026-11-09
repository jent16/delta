// Types for password-strength.js so the unit tests (TypeScript) can import it. The browser never sees this file.
export const WARNING: string;
export function passwordWeakness(password: string, email?: string): string | null;
