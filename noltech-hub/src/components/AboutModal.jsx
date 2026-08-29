// ─── About Modal ──────────────────────────────────────────────────────────────
// Brand moment. Shown from the sidebar footer "about" link.

import { Modal } from './ui';
import { Zap, Github, Mail } from 'lucide-react';

const BUILD_DATE = 'April 2026';
const VERSION    = '1.0';

export default function AboutModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} size="md" title="About NolTech Hub">
      <div className="space-y-4">
        {/* Hero wordmark — brand gradient mark + gradient-text accent */}
        <div className="relative flex items-center justify-center py-8 overflow-hidden rounded-xl bg-recessed">
          <div className="hero-mesh" />
          <div className="relative z-10 flex items-center gap-3">
            <div className="size-14 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-accent-glow">
              <span className="text-white font-bold text-2xl tracking-display">N</span>
            </div>
            <div>
              <p className="h-page-title text-fg tracking-heading">
                NolTech <span className="gradient-text">Hub</span>
              </p>
              <p className="text-xs text-fg-muted font-mono">v{VERSION} · {BUILD_DATE}</p>
            </div>
          </div>
        </div>

        <div className="space-y-3 text-sm text-fg-muted leading-relaxed">
          <p>
            <span className="text-fg font-medium">Built by a one-person shop, for one-person shops.</span>
            {' '}NolTech Hub is the operating system for a small electronics resale
            business: source lots, bid smart, receive inventory, test, list, sell,
            ship, and report to the IRS — all in one place that stays out of your way.
          </p>

          <p className="ui-eyebrow pt-1">Principles behind every screen</p>
          <ul className="list-none space-y-1.5 pl-0">
            <li className="flex items-start gap-2">
              <Zap className="size-3.5 text-fg shrink-0 mt-0.5" />
              <span><span className="text-fg font-medium">Speed is a feature.</span> Nothing waits on a spinner when it could show data.</span>
            </li>
            <li className="flex items-start gap-2">
              <Zap className="size-3.5 text-fg shrink-0 mt-0.5" />
              <span><span className="text-fg font-medium">The number is the point.</span> Chrome exists to serve the data, not decorate it.</span>
            </li>
            <li className="flex items-start gap-2">
              <Zap className="size-3.5 text-fg shrink-0 mt-0.5" />
              <span><span className="text-fg font-medium">Keyboard first.</span> <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono border border-border-subtle">⌘K</kbd> opens anywhere, <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono border border-border-subtle">?</kbd> shows what's possible.</span>
            </li>
          </ul>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-border text-[11px] text-fg-subtle">
          <span className="font-mono">Build {VERSION}</span>
          <div className="flex items-center gap-3">
            <a href="mailto:support@noltech.app" className="inline-flex items-center gap-1 hover:text-fg transition-colors">
              <Mail className="size-3" /> Support
            </a>
          </div>
        </div>
      </div>
    </Modal>
  );
}
