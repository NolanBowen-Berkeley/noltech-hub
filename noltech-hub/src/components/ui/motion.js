// ─── Shared motion variants ──────────────────────────────────────────────────
// Reusable Framer Motion configs. Import these to keep animations consistent
// across the app instead of hand-writing durations/easings at each call site.

// ─── Motion vocabulary ────────────────────────────────────────────────────
// Four roles. Don't invent new ones — pick from these so motion feels coherent.
//   ENTRY   — new element appearing (fade + slide)
//   EMPHASIS — drawing attention to a value that changed (scale pop)
//   FEEDBACK — confirming a user action (brief press)
//   TRANSITION — moving between views (longer, smoother)

const EASE_OUT    = [0.16, 1, 0.3, 1];    // out-expo — for entries + feedback
const EASE_IN_OUT = [0.87, 0, 0.13, 1];   // in-out-expo — for transitions
const EASE_BACK   = [0.34, 1.56, 0.64, 1]; // slight overshoot — for emphasis pops
const SPRING      = { type: 'spring', stiffness: 380, damping: 32 };
const SPRING_SOFT = { type: 'spring', stiffness: 260, damping: 24 };

// Named durations (ms) — only use these, never hand-pick
const DUR = { instant: 80, feedback: 140, entry: 220, emphasis: 280, transition: 320 };

// Page/view transitions — used by AnimatePresence wrapping view switchers
export const viewTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -4 },
  transition: { duration: 0.22, ease: EASE_OUT },
};

// Modal backdrop — fade + blur
export const modalBackdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit:    { opacity: 0 },
  transition: { duration: 0.16, ease: EASE_OUT },
};

// Modal panel — scale + fade
export const modalPanel = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1,    y: 0 },
  exit:    { opacity: 0, scale: 0.98, y: 4 },
  transition: { duration: 0.18, ease: EASE_OUT },
};

// Drawer (slide from right)
export const drawerPanel = {
  initial: { x: '100%' },
  animate: { x: 0 },
  exit:    { x: '100%' },
  transition: { duration: 0.26, ease: EASE_OUT },
};

// Stagger list container
export const listContainer = {
  animate: {
    transition: { staggerChildren: 0.04, delayChildren: 0.02 },
  },
};

// List item enter
export const listItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
  exit:    { opacity: 0, transition: { duration: 0.12 } },
};

// Success pop (checkmark after save)
export const successPop = {
  initial: { scale: 0, opacity: 0 },
  animate: { scale: 1, opacity: 1, transition: { ...SPRING, delay: 0 } },
  exit:    { scale: 0.8, opacity: 0, transition: { duration: 0.14 } },
};

// Shake on error
export const shakeError = {
  x: [0, -4, 4, -4, 4, -2, 2, 0],
  transition: { duration: 0.42, ease: EASE_IN_OUT },
};

// Breathing pulse (sync in progress, unread dot)
export const pulseLoop = {
  scale: [1, 1.06, 1],
  opacity: [0.9, 1, 0.9],
  transition: { duration: 1.6, ease: 'easeInOut', repeat: Infinity },
};

// Flash on value change — yellow→transparent highlight
export const flashHighlight = {
  initial: { backgroundColor: 'rgba(251, 191, 36, 0.35)' },
  animate: { backgroundColor: 'rgba(251, 191, 36, 0)' },
  transition: { duration: 0.6, ease: EASE_OUT },
};

// Button press — scale in on active
export const pressTap = { scale: 0.97 };

// Dropdown / popover
export const popover = {
  initial: { opacity: 0, scale: 0.97, y: -4 },
  animate: { opacity: 1, scale: 1,    y: 0 },
  exit:    { opacity: 0, scale: 0.98, y: -2 },
  transition: { duration: 0.14, ease: EASE_OUT },
};

// Emphasis pop — scale up briefly on value change
export const emphasisPop = {
  scale: [1, 1.04, 1],
  transition: { duration: 0.28, ease: EASE_BACK },
};

// Staggered dashboard KPI entry — use as parent variants
export const dashboardContainer = {
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};
export const dashboardChild = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT } },
};

export { EASE_OUT, EASE_IN_OUT, EASE_BACK, SPRING, SPRING_SOFT, DUR };
