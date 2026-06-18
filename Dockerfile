# Browser deps are present (Playwright base) even though Phase 1 launches no browser.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

# tini as PID 1 — reaps Chrome zombies (relevant from Phase 4; wired in now per ARCHITECTURE §7/§12).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
# No build step in Phase 1 — run TypeScript directly via tsx.
CMD ["npx", "tsx", "src/index.ts"]
