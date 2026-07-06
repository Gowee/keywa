import ipaddr from "ipaddr.js";

type CidrEntry = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** Parse and canonicalize an IP from request headers. */
export function parseClientIp(raw: string): string | null {
  // Take first IP if comma-separated (X-Forwarded-For chain)
  const first = raw.split(",")[0].trim();
  if (!ipaddr.isValid(first)) return null;
  const addr = ipaddr.process(first); // canonicalizes IPv4-mapped IPv6
  return addr.toString();
}

/**
 * Validate a comma-separated CIDR string.
 * Returns parsed [addr, prefix] pairs or an error message.
 */
export function parseCidrs(
  cidrsStr: string,
): { ok: true; cidrs: CidrEntry[] } | { ok: false; error: string } {
  const parts = cidrsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cidrs: CidrEntry[] = [];
  for (const part of parts) {
    if (ipaddr.isValidCIDR(part)) {
      cidrs.push(ipaddr.parseCIDR(part));
    } else if (ipaddr.isValid(part)) {
      // Plain IP → treat as /32 (IPv4) or /128 (IPv6)
      const addr = ipaddr.process(part);
      const prefix = addr.kind() === "ipv4" ? 32 : 128;
      cidrs.push([addr, prefix]);
    } else {
      return { ok: false, error: `Invalid CIDR: ${part}` };
    }
  }
  return { ok: true, cidrs };
}

/** Check if a client IP matches any CIDR in the allowlist. */
export function ipMatchesCidrs(clientIp: string, cidrs: CidrEntry[]): boolean {
  if (!cidrs.length) return true; // empty allowlist = skip check
  if (!ipaddr.isValid(clientIp)) return false;
  const addr = ipaddr.process(clientIp);
  const kind = addr.kind();
  return cidrs.some((entry) => entry[0].kind() === kind && addr.match(entry));
}

/** Strip /32 (IPv4) and /128 (IPv6) suffixes for cleaner storage. */
export function normalizeCidrs(cidrsStr: string): string {
  return cidrsStr
    .split(",")
    .map((s) => {
      const part = s.trim();
      if (!part) return part;
      if (ipaddr.isValidCIDR(part)) {
        const [addr, prefix] = ipaddr.parseCIDR(part);
        const maxPrefix = addr.kind() === "ipv4" ? 32 : 128;
        return prefix === maxPrefix ? addr.toString() : part;
      }
      return part; // plain IP or invalid — leave as-is (validated elsewhere)
    })
    .filter(Boolean)
    .join(", ");
}
