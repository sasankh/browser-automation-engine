import { describe, it, expect } from 'vitest';
import {
  assertAllowedUrl,
  buildUrlGuardOptions,
  SsrfError,
  isPrivateHost,
  isOffSite,
  registrableDomain,
} from '../../src/browser/ssrf-guard';

describe('ssrf-guard — target safety', () => {
  it('blocks private / loopback / link-local / metadata hosts by default', () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://192.168.0.5/x',
      'http://172.16.9.9/x',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://localhost:8080/x',
      'http://[::1]/x',
    ]) {
      expect(() => assertAllowedUrl(url), url).toThrowError(SsrfError);
    }
  });

  it('allows public hosts', () => {
    expect(assertAllowedUrl('https://example.com/path').hostname).toBe('example.com');
  });

  it('permits private hosts only with allowAllPrivate (the dev/test fixture convenience)', () => {
    expect(assertAllowedUrl('http://127.0.0.1:3100/lookup', { allowAllPrivate: true }).hostname).toBe('127.0.0.1');
  });

  it('ALLOWED_PRIVATE_CIDRS permits only the listed range, still blocking others', () => {
    const opts = buildUrlGuardOptions(false, '10.0.0.0/8, 192.168.1.0/24');
    expect(assertAllowedUrl('http://10.4.5.6/x', opts).hostname).toBe('10.4.5.6'); // in 10.0.0.0/8
    expect(assertAllowedUrl('http://192.168.1.50/x', opts).hostname).toBe('192.168.1.50'); // in /24
    expect(() => assertAllowedUrl('http://192.168.2.50/x', opts)).toThrowError(SsrfError); // outside the /24
    expect(() => assertAllowedUrl('http://169.254.169.254/x', opts)).toThrowError(SsrfError); // metadata still blocked
  });

  it('buildUrlGuardOptions tolerates an empty/garbage CIDR list', () => {
    expect(buildUrlGuardOptions(false, undefined).allowedCidrs).toEqual([]);
    expect(buildUrlGuardOptions(false, 'not-a-cidr, ').allowedCidrs).toEqual([]);
  });

  it('rejects non-http(s) schemes and malformed urls', () => {
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrowError(SsrfError);
    expect(() => assertAllowedUrl('not a url')).toThrowError(SsrfError);
  });

  it('isPrivateHost flags internal names and public names alike', () => {
    expect(isPrivateHost('foo.internal')).toBe(true);
    expect(isPrivateHost('service.local')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
  });
});

describe('ssrf-guard — domain confinement', () => {
  it('treats the registrable domain coarsely (last two labels)', () => {
    expect(registrableDomain('www.mbc.ca.gov')).toBe('ca.gov');
    expect(registrableDomain('example.com')).toBe('example.com');
  });

  it('detects off-site navigation away from the target', () => {
    expect(isOffSite('https://site.com/a', 'https://site.com/b')).toBe(false);
    expect(isOffSite('https://site.com/a', 'https://sub.site.com/b')).toBe(false); // same registrable
    expect(isOffSite('https://site.com/a', 'https://evil.com/b')).toBe(true);
  });
});
