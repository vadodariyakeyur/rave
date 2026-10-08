/**
 * How a passcode sits in a share link: base64url, so it is not readable at a
 * glance over someone's shoulder or in a screenshot.
 *
 * Obfuscation, not protection: anyone with the link can decode it in a
 * second, and that is accepted. UTF-8 first, because btoa alone throws on
 * anything past Latin-1.
 */
export function encodePasscode(passcode: string): string {
  const bytes = new TextEncoder().encode(passcode);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** Undefined for anything that is not what encodePasscode makes, so a mangled link just asks. */
export function decodePasscode(encoded: string): string | undefined {
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}
