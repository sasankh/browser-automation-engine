/**
 * URL safety for caller-supplied targets, **replay `goto`s, and every agent navigation** (ARCHITECTURE
 * §9, PROJECT_SPEC §13). Refuse private / loopback / link-local / carrier-NAT / cloud-metadata hosts by
 * default; a deliberate internal target is opted in via `ALLOWED_PRIVATE_CIDRS` (CIDR allowlist) — or
 * `ALLOW_PRIVATE_TARGETS=true` to permit all private hosts (dev/test, e.g. the 127.0.0.1 fixture).
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface ParsedCidr {
  v6: boolean;
  base: bigint;
  prefix: number;
}

export interface UrlGuardOptions {
  /** Permit ALL private/loopback/link-local hosts (the `ALLOW_PRIVATE_TARGETS` dev convenience). */
  allowAllPrivate?: boolean;
  /** Deliberate internal targets allowed by CIDR (`ALLOWED_PRIVATE_CIDRS`). */
  allowedCidrs?: ParsedCidr[];
}

/** Build guard options from env values (used by both the replay and agent paths). */
export function buildUrlGuardOptions(allowAllPrivate: boolean, cidrsCsv?: string): UrlGuardOptions {
  const allowedCidrs = (cidrsCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== null);
  return { allowAllPrivate, allowedCidrs };
}

/** Throw `SsrfError` if the URL is malformed, non-http(s), or targets a blocked host. */
export function assertAllowedUrl(rawUrl: string, opts: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`malformed url: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`unsupported url scheme: ${url.protocol}`);
  }
  if (isPrivateHost(url.hostname)) {
    if (opts.allowAllPrivate) return url;
    const ip = ipToBigInt(url.hostname.replace(/^\[|\]$/g, ''));
    if (ip && opts.allowedCidrs?.some((c) => ipInCidr(ip, c))) return url;
    throw new SsrfError(`blocked private/internal target: ${url.hostname}`);
  }
  return url;
}

/** True if the host is loopback/private/link-local/CGNAT/metadata, or a non-public hostname. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (isIpv4(host)) return isPrivateIpv4(host);
  if (host.includes(':')) return isPrivateIpv6(host); // IPv6 literal
  return false; // a public DNS name; post-resolution checks are out of scope (we deny by literal)
}

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true; // private, loopback, "this host"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10
  return false;
}

/** Parse a CIDR string ("10.0.0.0/8", "::1/128") to a comparable base+prefix, or null if malformed. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const [addr, prefixStr] = cidr.split('/');
  if (!addr || prefixStr === undefined) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0) return null;
  const v6 = addr.includes(':');
  const base = ipToBigInt(addr);
  if (base === null) return null;
  if (v6 ? prefix > 128 : prefix > 32) return null;
  return { v6, base, prefix };
}

/** Convert an IPv4 or (compact) IPv6 literal to a bigint, or null if it isn't a literal. */
function ipToBigInt(addr: string): bigint | null {
  if (isIpv4(addr)) {
    return addr.split('.').reduce((acc, oct) => (acc << 8n) + BigInt(Number(oct)), 0n);
  }
  if (addr.includes(':')) {
    const [head, tail] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    const groups = [...headParts, ...Array<string>(missing).fill('0'), ...tailParts];
    if (groups.length !== 8) return null;
    try {
      return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
    } catch {
      return null;
    }
  }
  return null;
}

function ipInCidr(ip: bigint, cidr: ParsedCidr): boolean {
  const bits = cidr.v6 ? 128 : 32;
  if (cidr.prefix === 0) return true;
  const mask = ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(bits - cidr.prefix);
  return (ip & mask) === (cidr.base & mask);
}

/**
 * The registrable domain for confinement comparison — a deliberately simple "last two labels"
 * heuristic (no PSL dependency). IP hosts compare whole. Multi-part TLDs are treated coarsely.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpv4(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  return labels.slice(-2).join('.');
}

/** True if navigating from `fromUrl` to `toUrl` leaves the target's registrable domain. */
export function isOffSite(fromUrl: string, toUrl: string): boolean {
  try {
    return registrableDomain(new URL(fromUrl).hostname) !== registrableDomain(new URL(toUrl).hostname);
  } catch {
    return true; // unparseable destination ⇒ treat as off-site (fail safe)
  }
}
