import { describe, it, expect } from 'vitest';
import { assertAllowedUrl, SsrfError, isPrivateHost, isOffSite, registrableDomain } from '../../src/browser/ssrf-guard';

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

  it('permits private hosts only when explicitly allowed (the local fixture)', () => {
    expect(assertAllowedUrl('http://127.0.0.1:3100/lookup', { allowPrivateHosts: true }).hostname).toBe('127.0.0.1');
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
