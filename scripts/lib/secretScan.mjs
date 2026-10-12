/**
 * What a committed secret looks like. The repository is public, so a key in
 * any tracked file is a leaked key. These patterns are deliberately narrow:
 * a false alarm on every mention of "pk_" would teach everyone to ignore it.
 */

// A file named .env or .env.<anything>. Keys live in Doppler, never in a file.
export const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;

const CONTENT_PATTERNS = [
  // ClickUp personal token: pk_<digits>_<long upper-case alphanumeric tail>.
  { label: 'a ClickUp pk_ token', re: /\bpk_\d{4,}_[A-Z0-9]{20,}\b/ },
  // Supabase's newer secret key format.
  { label: 'a Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
];

// A JSON Web Token: three base64url parts. Supabase's legacy service key is
// one whose payload says "role":"service_role" (the anon key says "anon").
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function isServiceRoleJwt(payloadPart) {
  try {
    const json = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    return json && json.role === 'service_role';
  } catch {
    return false;
  }
}

/** Every reason this file looks like a leaked secret (empty when clean). */
export function findSecrets(path, text) {
  const hits = [];
  if (ENV_FILE.test(path)) hits.push('a .env file (keys belong in Doppler)');
  if (text == null) return hits;
  text.split('\n').forEach((line, i) => {
    for (const { label, re } of CONTENT_PATTERNS) {
      if (re.test(line)) hits.push(`line ${i + 1}: looks like ${label}`);
    }
    for (const m of line.matchAll(JWT)) {
      if (isServiceRoleJwt(m[1])) hits.push(`line ${i + 1}: looks like a Supabase service-role key`);
    }
  });
  return hits;
}
