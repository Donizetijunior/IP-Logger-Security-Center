export const RESERVED_SLUGS = new Set([
  'api', 'admin', 'painel', 'privacy', 'healthz', 'readyz', 'metrics', 'login', 'logout',
  'static', 'assets', 'robots.txt', 'favicon.ico', 'sitemap.xml', 'well-known', '.well-known',
]);

export const SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && !RESERVED_SLUGS.has(slug.toLowerCase());
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateSlug(
  length = 8,
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = random(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return out;
}
