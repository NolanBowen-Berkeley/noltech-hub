# SaaS Readiness — Dashboard Actions Required

These settings must be enabled in the Supabase dashboard (not SQL). Complete them before public launch.

## 1. Email Confirmation (CRITICAL)

**Supabase Dashboard → Authentication → Sign In / Up → Email**
- Toggle ON **"Confirm email"**
- This forces every new signup to click a verification link before they can sign in.

Without this, anyone can sign up with someone else's email. We turned it off for testing — turn it back on for production.

## 2. Password Policy (CRITICAL)

**Supabase Dashboard → Authentication → Policies → Password**
- Enable **"Check against HaveIBeenPwned"**
- Set **Minimum password length = 8** (code already enforces this client-side)

## 3. Rate Limits (CRITICAL)

**Supabase Dashboard → Authentication → Rate Limits**
- Email signups per hour per IP: **10** (default is 30; too permissive for public launch)
- Magic link / OTP requests per hour: **5**
- Token refreshes per 5 min: **150** (keep default)

## 4. Redirect URLs for Password Reset

**Supabase Dashboard → Authentication → URL Configuration**
- Add **Site URL** to match your app domain
- Add **Redirect URL**: `noltech://password-reset` (Electron custom protocol, TODO)

Until the Electron custom protocol is wired up, password reset links open in the user's browser and can't automatically return to the app. Workaround: reset in browser, then sign in with new password inside the app.

## 5. Email Templates

**Supabase Dashboard → Authentication → Email Templates**
- Customize **Confirmation Signup** and **Reset Password** templates
- Add NolTech branding, support email, and privacy policy link
- Default templates say "noreply@mail.app.supabase.io" which looks sketchy to new users

## 6. MFA / 2FA (HIGH PRIORITY for paid users)

**Supabase Dashboard → Authentication → Providers → Phone** (or TOTP)
- Enable TOTP factors
- Wire into app: `supabase.auth.mfa.enroll()` — not yet implemented

## 7. Custom SMTP

**Supabase Dashboard → Settings → Auth → SMTP Settings**
- Default Supabase SMTP is rate-limited (~30 emails/hr) — insufficient for production
- Connect to SendGrid, Postmark, or AWS SES

## 8. Migrations to Run (in order)

```
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_fix_workspace_rls.sql
supabase/migrations/003_invites.sql
supabase/migrations/004_extend_sync.sql
supabase/migrations/005_audit_log.sql
supabase/migrations/006_account_deletion.sql
supabase/migrations/007_subscriptions.sql
```

All migrations are idempotent — re-running is safe.

## 9. Still Pending (Tier 2 items)

- [ ] Stripe integration for paid subscriptions
- [ ] Webhook handler to update `subscriptions` table on checkout/cancellation
- [ ] Electron code signing (Windows EV cert + Apple Developer)
- [ ] Auto-updater via `electron-updater`
- [ ] Sentry error tracking
- [ ] Scraper rate limiting (`express-rate-limit`)
- [ ] Legal review of liquidation-site scraping ToS

## 10. Critical File References

- Password validation: `src/services/supabase.js` → `validatePassword()`
- Password reset: `src/services/supabase.js` → `requestPasswordReset()`, `updatePassword()`
- Account deletion: `src/services/supabase.js` → `deleteMyAccount()` + migration 006
- Tier enforcement: `src/services/tiers.js` + migration 007 (`subscriptions` table, RLS-locked)
- Legal text: `src/components/LegalModal.jsx`
