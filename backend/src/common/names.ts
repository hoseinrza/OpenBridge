// Sign-up collects the given name and (optionally) the family name, while the
// rest of the app shows one display name. It is always derived from the parts
// so the two can never drift apart.
export function displayNameOf(firstName?: string | null, lastName?: string | null): string | null {
  const parts = [firstName, lastName].map(part => part?.trim() ?? '').filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}
