// ─── Sync Status Indicator ───────────────────────────────────────────────────
// Shows a cloud icon with color indicating sync state.

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Cloud, CloudOff, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { onStatusChange } from '../services/syncEngine';
import { isCloudEnabled } from '../services/supabase';

const CONFIG = {
  idle:    { icon: Cloud,       color: 'text-fg-subtle',                title: 'Cloud sync idle' },
  syncing: { icon: RefreshCw,   color: 'text-accent animate-spin',      title: 'Syncing…' },
  synced:  { icon: Check,       color: 'text-success',                  title: 'All changes synced' },
  offline: { icon: CloudOff,    color: 'text-warning',                  title: 'Offline — changes queued' },
  error:   { icon: AlertCircle, color: 'text-danger',                   title: 'Sync error' },
};

export default function SyncStatusIndicator() {
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    if (!isCloudEnabled) return;
    return onStatusChange(setStatus);
  }, []);

  if (!isCloudEnabled) return null;

  const cfg = CONFIG[status] || CONFIG.idle;
  const Icon = cfg.icon;

  const pulsing = status === 'syncing' || status === 'error';
  return (
    <div className="flex items-center gap-1.5 text-[10px]" title={cfg.title}>
      <motion.span
        animate={pulsing ? { scale: [1, 1.12, 1], opacity: [0.85, 1, 0.85] } : { scale: 1, opacity: 1 }}
        transition={pulsing ? { duration: 1.4, ease: 'easeInOut', repeat: Infinity } : { duration: 0.2 }}
        className="inline-flex"
      >
        <Icon size={11} className={cfg.color} />
      </motion.span>
      <span className="text-fg-muted capitalize">{status === 'synced' ? 'Synced' : status}</span>
    </div>
  );
}
