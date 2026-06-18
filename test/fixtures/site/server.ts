import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Offline express fixture site for deterministic integration tests. Three flows:
 *  - /lookup -> /results : a lookup form to a results page with extractable fields (extraction).
 *  - /action            : an action-only form that submits to a confirmation page (no results).
 *  - /v2/lookup -> /v2/results : the same flow with RENAMED selectors (Phase 5 heal tests).
 */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function parseCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export function createFixtureApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/lookup', (_req, res) => {
    res.send(
      page(
        'Lookup',
        `<h1>License Lookup</h1>
         <form action="/results" method="get">
           <input id="licNum" name="license_number" type="text" />
           <input id="lastNm" name="last_name" type="text" />
           <button id="submit" type="submit">Search</button>
         </form>`,
      ),
    );
  });

  app.get('/results', (req, res) => {
    const lic = String(req.query.license_number ?? '');
    const last = String(req.query.last_name ?? '');
    res.send(
      page(
        'Results',
        `<h1>Results</h1>
         <div class="results-table">
           <div class="status">active</div>
           <div class="holder">${last.toUpperCase()}, ${lic}</div>
           <div class="expiry">2027-12-31</div>
         </div>`,
      ),
    );
  });

  app.get('/action', (_req, res) => {
    res.send(
      page(
        'Contact',
        `<h1>Contact</h1>
         <form action="/action/submit" method="post">
           <input id="name" name="name" type="text" />
           <input id="email" name="email" type="text" />
           <textarea id="message" name="message"></textarea>
           <button id="send" type="submit">Send</button>
         </form>`,
      ),
    );
  });

  app.post('/action/submit', (_req, res) => {
    res.send(page('Sent', `<h1 class="confirmation">Thank you</h1><p>Your message was sent.</p>`));
  });

  // Mutated variant — renamed selectors; reserved for Phase 5 heal tests.
  app.get('/v2/lookup', (_req, res) => {
    res.send(
      page(
        'Lookup v2',
        `<h1>License Lookup</h1>
         <form action="/v2/results" method="get">
           <input id="licNumber" name="license_number" type="text" />
           <input id="lastName" name="last_name" type="text" />
           <button id="searchBtn" type="submit">Search</button>
         </form>`,
      ),
    );
  });

  app.get('/v2/results', (req, res) => {
    const lic = String(req.query.license_number ?? '');
    const last = String(req.query.last_name ?? '');
    res.send(
      page(
        'Results v2',
        `<h1>Results</h1>
         <section class="result-panel">
           <span class="result-status">active</span>
           <span class="result-holder">${last.toUpperCase()}, ${lic}</span>
           <span class="result-expiry">2027-12-31</span>
         </section>`,
      ),
    );
  });

  // Isolation: a per-run token is filled into a form that stamps it into THIS context's cookie +
  // localStorage (/iso/apply), then read back (/iso/read). This drives the real fill->click->extract
  // op path — `goto` does not template by design, so the token must flow through a form, exactly as a
  // compiled playbook would parameterize a search.
  app.get('/iso/set', (_req, res) => {
    res.send(
      page(
        'Set',
        `<form action="/iso/apply" method="get">
           <input id="token" name="token" type="text" />
           <button id="apply" type="submit">Set</button>
         </form>`,
      ),
    );
  });

  app.get('/iso/apply', (req, res) => {
    const token = String(req.query.token ?? '');
    res.cookie('iso_token', token, { httpOnly: false, sameSite: 'lax' });
    res.send(
      page(
        'Applied',
        `<div class="done">ok</div>
         <script>try { localStorage.setItem('iso_token', ${JSON.stringify(token)}); } catch (e) {}</script>`,
      ),
    );
  });

  app.get('/iso/read', (req, res) => {
    const cookieToken = parseCookie(req.headers.cookie ?? '', 'iso_token');
    res.send(
      page(
        'Read',
        `<div class="cookie-token">${escapeHtml(cookieToken)}</div>
         <div class="ls-token" id="ls"></div>
         <script>try { document.getElementById('ls').textContent = localStorage.getItem('iso_token') || ''; } catch (e) {}</script>`,
      ),
    );
  });

  // Cap/backpressure: a run that takes a known amount of time.
  app.get('/slow', (req, res) => {
    const ms = Math.min(Number(req.query.ms ?? 400) || 400, 10_000);
    setTimeout(() => res.send(page('Slow', `<div class="done">ok</div>`)), ms);
  });

  // Timeout: hold the response far longer than any test's wall clock (self-resolves for cleanup).
  app.get('/hang', (_req, res) => {
    setTimeout(() => res.send(page('Hang', `<div class="done">late</div>`)), 60_000);
  });

  return app;
}

export interface FixtureHandle {
  url: string;
  close: () => Promise<void>;
}

export function startFixture(port = 0): Promise<FixtureHandle> {
  const app = createFixtureApp();
  return new Promise((resolve) => {
    const server: Server = app.listen(port, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// CLI: serve for manual use / the docker-compose `fixture` service.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FIXTURE_PORT ?? 3100);
  void startFixture(port).then(({ url }) => {
    console.log(`fixture site listening at ${url}`);
  });
}
