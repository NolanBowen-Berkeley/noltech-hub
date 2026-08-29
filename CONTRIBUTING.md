# Contributing

## Setup

```bash
git clone <your-fork>
cd noltech-hub

# Pipeline — the local service the Hub talks to
cd noltech-pipeline && npm install && cp .env.example .env && npm start
```

It boots with no configuration at all: the sample providers mean there's
nothing to fill in before you see it work. `curl localhost:3001/health` should
answer, and `curl localhost:3001/diag/providers` tells you what's wired up.

```bash
# Hub — the desktop app
cd noltech-hub && npm install && cp .env.example .env
npm run electron:dev
```

The Hub needs a Supabase project for auth and storage. Point `.env` at yours
and apply the migrations in `noltech-hub/supabase/migrations/` in order.

## Ground rules

**No scrapers.** Pull requests that fetch and parse a site's HTML to get around
its terms of service will be closed, however well-written. If you need a data
source that isn't supported, add a provider
(see [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)) and document what
authorizes it.

**No credentials in commits.** Not in code, not in tests, not in fixtures, not
in a commit you plan to amend later. See [SECURITY.md](SECURITY.md).

**No real business data in fixtures.** Sample data is generated in
`noltech-pipeline/src/providers/fixtures.js`. Real order numbers, customer
names, and supplier invoices don't belong in a public repository even as test
input.

## Style

Match the file you're editing. Broadly:

- Comments explain *why*, not *what*. The existing codebase leans heavily on
  header comments that explain a module's role and the non-obvious decisions
  inside it — keep that up; it's the main reason this is navigable.
- When you fix a subtle bug, say what the old behavior was in a comment. There
  are several of these already ("the legacy version accepted any HTML > 500
  chars, which false-positived on 404 pages") and they're the difference
  between a fix that sticks and one that gets reverted by someone who doesn't
  know why it's there.
- No hard tabs. Two spaces.

## Before opening a PR

```bash
cd noltech-hub     && npm run build     # must succeed
cd noltech-pipeline && npm start -- --no-crons   # must boot cleanly
```

Say in the PR description what you actually ran. "Should work" is not a test
result.
