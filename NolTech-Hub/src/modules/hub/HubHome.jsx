// ─── Hub Home ─────────────────────────────────────────────────────────────────
// Thin wrapper around HubDashboard. Tabs removed — dashboard IS the hub.

import HubDashboard from './HubDashboard';

export default function HubHome({ setView }) {
  return <HubDashboard setView={setView} />;
}
