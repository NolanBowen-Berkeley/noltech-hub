# Security

## Reporting a vulnerability

Open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than a public issue. Please don't disclose publicly
until a fix is available.

## Handling credentials

This project talks to Supabase, eBay, and optionally Anthropic or Google AI.
That's a lot of credentials for a desktop app, so the rules are worth stating
plainly.

**Never commit a `.env`.** The root `.gitignore` ignores every `.env` and
`.env.*` except `.env.example`. Before your first push:

```bash
git ls-files | grep -E '\.env$|\.env\.' || echo "no env files tracked"
```

**Never commit `dist/`.** Vite inlines every `VITE_*` variable into the bundle
at build time. A committed `dist/` is a committed `.env`, just harder to
notice. Same for `release/` — a packaged Electron app bundles the `.env` that
was present when it was built.

**Know which keys are which.**

| Key | Exposure | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_ANON_KEY` | Ships to the client. Public by design. | Safe only if row-level security is actually enforced — see below. |
| `SUPABASE_SERVICE_KEY` | Server-side only. Never in the Hub. | Bypasses row-level security entirely. Treat as a root password. |
| `EBAY_CERT_ID`, refresh tokens | Server-side only. | Rotate through the eBay developer portal. |
| `SHARED_AUTH_SECRET` | Server-side only. | Required whenever the pipeline binds anything but loopback. |

The anon key being public is only safe because RLS policies decide what it can
reach. Those policies are in `noltech-hub/supabase/migrations/` — review them
before pointing this at a project holding real data. A missing policy on one
table is enough to undo the rest.

**Bind the pipeline to loopback.** `PIPELINE_BIND_HOST` defaults to
`127.0.0.1` and runs without auth there, which is the right default for a
desktop install. If you bind a LAN address, set `SHARED_AUTH_SECRET` in the
same change — the lot routes will happily spend whatever your configured
provider costs on behalf of anyone who can reach the port.

## If you leak a key

Rotate first, scrub second — in that order. Removing a secret from git history
does not un-leak it; anything pushed to a public repository should be assumed
captured within minutes.

1. Rotate the credential at the provider (Supabase → Settings → API,
   eBay → developer portal, etc.).
2. Then clean history with [`git filter-repo`](https://github.com/newren/git-filter-repo)
   or [BFG](https://rtyley.github.io/bfg-repo-cleaner/), and force-push.
3. Check whether the provider offers an audit log for the exposure window.

## Scope

This is a single-tenant desktop application that assumes the person running it
owns the workspace it points at. It has not been audited for multi-tenant
deployment. The `workspace_id` boundary is enforced by Supabase RLS, not by
the client — don't rely on the UI to keep tenants apart.
