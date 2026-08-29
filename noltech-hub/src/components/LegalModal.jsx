import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { modalBackdrop, modalPanel } from './ui/motion';

const LAST_UPDATED = 'April 14, 2026';

const TERMS = `NolTech Hub Terms of Service

Last updated: ${LAST_UPDATED}

1. Acceptance
By creating an account or using NolTech Hub ("the Service"), you agree to these Terms. If you do not agree, do not use the Service.

2. The Service
NolTech Hub is inventory, sales, and arbitrage software for electronics resellers. It is provided as-is with no warranty of uptime, fitness for a particular purpose, or profitability of any resale activity. You are solely responsible for your business decisions, tax filings, and legal compliance.

3. Your Account
You are responsible for keeping your credentials confidential. You must provide accurate information and promptly update it if it changes. You must be at least 18 years old or the age of majority in your jurisdiction.

4. Acceptable Use
You agree not to: (a) reverse-engineer or circumvent the Service, (b) use the Service to violate any law, (c) scrape or abuse third-party sites in a way that violates their terms, (d) resell or redistribute the Service without permission, (e) attempt to access another user's workspace without authorization.

5. Your Data
You retain ownership of all data you input. You grant NolTech a limited license to store, process, and display that data solely to operate the Service for you. You are responsible for backing up your data; while we maintain commercially reasonable backups, we do not guarantee data recovery in all circumstances.

6. Third-Party Services
The Service integrates with eBay, Anthropic, liquidation marketplaces, and other third parties. You are responsible for your relationship with and compliance with the terms of those services. Your API keys and tokens are stored encrypted on your device.

7. Fees and Subscriptions
If you subscribe to a paid tier, fees are billed in advance and non-refundable except where required by law. We may change pricing with 30 days' notice.

8. Termination
You may delete your account at any time from within the app. We may suspend or terminate accounts for violations of these Terms. Upon termination, your cloud-stored data is deleted; local data on your device remains unless you remove the app.

9. Limitation of Liability
To the maximum extent permitted by law, NolTech's total liability is limited to the fees you paid in the 12 months preceding the claim, or $100, whichever is greater. We are not liable for lost profits, lost data, or indirect damages.

10. Indemnification
You agree to indemnify NolTech against claims arising from your use of the Service, including any violation of third-party terms (eBay, liquidation sites, tax authorities).

11. Changes
We may update these Terms. Material changes will be announced in-app or by email at least 14 days before taking effect. Continued use after changes constitutes acceptance.

12. Governing Law
These Terms are governed by the laws of the State of California, USA. Disputes will be resolved in the state or federal courts of Los Angeles County.

13. Contact
Questions? Contact support at the email listed in Settings > About.`;

const PRIVACY = `NolTech Hub Privacy Policy

Last updated: ${LAST_UPDATED}

1. What We Collect
Account data: email address, hashed password (managed by Supabase Auth).
Business data you enter: inventory, lots, bids, sales, transactions, notes.
Technical data: error logs, sync timestamps, app version. We do not sell this data.

2. What We Don't Collect
We do not collect: your eBay credentials, Anthropic API key, or device-level credentials. These stay encrypted on your device and never leave it.
We do not track your browsing, scrape your email, or share data with advertisers.

3. How We Store It
Cloud sync data is stored in Supabase (PostgreSQL) in the US region. Each row is protected by row-level security tied to your workspace. Data in transit is TLS-encrypted; data at rest is encrypted by Supabase's infrastructure.
Local data lives in IndexedDB on your device. You control it. Uninstalling the app removes it.

4. Who Can See Your Data
Only you and teammates you explicitly invite to your workspace. Workspace isolation is enforced by row-level security at the database layer.
NolTech staff do not access your data except (a) with your explicit support request, (b) to respond to a valid legal order, or (c) to investigate abuse.

5. Third-Party Processors
Supabase (auth, database, realtime) — https://supabase.com/privacy
Anthropic (AI features, only if you provide your own key) — https://www.anthropic.com/legal/privacy

6. Your Rights
You can export all your cloud data from Settings > Data Backup.
You can permanently delete your account from Settings > Workspace > Delete account. This removes your cloud data within 30 days.
Under GDPR / CCPA you have the right to access, correct, or delete your personal data, and to data portability. Contact support to exercise these rights.

7. Children
The Service is not directed at children under 13 (16 in the EU). We do not knowingly collect data from minors.

8. Breach Notification
If we become aware of a security breach affecting your personal data, we will notify you within 72 hours with the scope of the breach and recommended mitigations.

9. Changes
We will notify you in-app or by email at least 14 days before material changes take effect.

10. Contact
Contact support at the email listed in Settings > About for privacy requests.`;

export default function LegalModal({ kind, onClose }) {
  const title = kind === 'privacy' ? 'Privacy Policy' : 'Terms of Service';
  const body = kind === 'privacy' ? PRIVACY : TERMS;

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <motion.div {...modalPanel} className="glossy-elevated w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="font-semibold text-fg">{title}</h3>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-muted rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 overflow-y-auto text-xs text-fg whitespace-pre-wrap leading-relaxed font-sans">
          {body}
        </div>
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90">
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
