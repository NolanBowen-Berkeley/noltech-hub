# Supabase setup

The migrations in `migrations/` create the schema and the row-level security
policies. Everything below has to be done in the Supabase dashboard instead —
it isn't expressible in SQL.

Apply migrations in numeric order. All are idempotent; re-running is safe.

## Before you put real data in it

**Email confirmation.** Authentication → Sign In / Up → Email → turn on
*Confirm email*. Without it, anyone can sign up with an address they don't
control.

**Password policy.** Authentication → Policies → Password → enable
*Check against HaveIBeenPwned* and set a minimum length of 8. The client
enforces 8 in `src/services/supabase.js` → `validatePassword()`, but a
client-side check is a UX affordance, not a control.

**Rate limits.** Authentication → Rate Limits. The defaults are tuned for
development. Reasonable production values: 10 email signups/hour/IP,
5 magic-link or OTP requests/hour, and leave token refresh at its default.

**Redirect URLs.** Authentication → URL Configuration → set your Site URL. The
Electron custom-protocol handler for password resets isn't wired up yet, so
reset links open in the browser; users reset there and then sign in.

**Email templates.** Authentication → Email Templates. Customize the
confirmation and password-reset emails. The defaults come from
`noreply@mail.app.supabase.io`, which reads as phishing to a new user.

**Custom SMTP.** Settings → Auth → SMTP. Supabase's built-in sender is rate
limited to roughly 30 emails/hour — fine for yourself, not for other people.

**MFA.** Authentication → Providers → enable TOTP. Enrollment isn't wired into
the app yet (`supabase.auth.mfa.enroll()` is unused), so this is a prerequisite
for a feature that still needs building.

## What the migrations already handle

Every table has row-level security enabled with workspace-scoped policies —
26 tables, no exceptions. The `workspace_id` boundary is enforced there, in the
database, not in the client. If you add a table, add its policies in the same
migration; a table without them is readable by every authenticated user of your
project.

`sync_state` caches an eBay OAuth access token per workspace. It's
RLS-protected to workspace members, but it is a bearer credential sitting in
your database — worth knowing when you decide who gets workspace membership.

## Not implemented

- Stripe integration and the webhook that would keep `subscriptions` current.
  The table and tier-enforcement logic (`src/services/tiers.js`, migration 007)
  exist; nothing writes to them.
- Electron code signing and auto-update.
- Error tracking.

## Where the relevant code lives

| | |
| --- | --- |
| Password validation, reset, account deletion | `src/services/supabase.js` |
| Tier enforcement | `src/services/tiers.js` + migration 007 |
| Legal text shown in-app | `src/components/LegalModal.jsx` |
