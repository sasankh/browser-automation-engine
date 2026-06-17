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
