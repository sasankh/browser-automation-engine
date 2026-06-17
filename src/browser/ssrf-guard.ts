/**
 * URL safety for caller-supplied targets and agent navigation (ARCHITECTURE §9, EXECUTION_STANDARDS
 * §4). Two concerns, both pure/testable:
 *  - **SSRF:** refuse private / loopback / link-local / carrier-NAT / cloud-metadata hosts unless
 *    explicitly allowed (the local fixture runs on 127.0.0.1, so dev/test sets `allowPrivateHosts`).
 *  - **Domain confinement:** the agent may not wander off the target site's registrable domain unless
 *    `allow_offsite` is set — the Phase-4 off-site guardrail.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface UrlGuardOptions {
  /** Permit private/loopback/link-local hosts (default false). Set in local/test against the fixture. */
  allowPrivateHosts?: boolean;
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
  if (!opts.allowPrivateHosts && isPrivateHost(url.hostname)) {
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
  return false; // a public DNS name; deny rules apply post-resolution in prod (Phase 7), out of scope here
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

/**
 * The registrable domain for confinement comparison — a deliberately simple "last two labels"
 * heuristic (no PSL dependency). Good enough to confine an agent to the target site; IP hosts compare
 * whole. Multi-part TLDs (`co.uk`) are intentionally treated coarsely; revisit if a target needs it.
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
