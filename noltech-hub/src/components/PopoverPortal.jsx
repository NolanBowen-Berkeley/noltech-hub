// ─── PopoverPortal ───────────────────────────────────────────────────────────
// Wraps a trigger button + a dropdown menu so the menu renders in a React
// portal at document.body with position: fixed. Solves the z-index clipping
// problem where a dropdown rendered inside a card gets covered by the next
// sibling card (cards each form their own stacking context, so z-index alone
// doesn't lift the dropdown above siblings).
//
// Behavior:
//   - Click trigger → menu opens, anchored to trigger's right-bottom
//   - Click outside menu/trigger → closes
//   - Scroll or resize → closes (fixed position would otherwise detach)
//   - Esc → closes
//
// Usage:
//   <PopoverPortal
//     align="right"       // 'right' (default) | 'left'
//     renderTrigger={({ ref, onClick, open }) => (
//       <button ref={ref} onClick={onClick} className={open ? 'active' : ''}>...</button>
//     )}
//     renderMenu={({ close }) => (
//       <>
//         <MenuItem onClick={...} />
//       </>
//     )}
//   />

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

export default function PopoverPortal({ renderTrigger, renderMenu, align = 'right', menuClassName = '', zIndex = 1000 }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, right: 0 });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      if (align === 'left') {
        setPos({ top: rect.bottom + 4, left: rect.left, right: 0 });
      } else {
        setPos({ top: rect.bottom + 4, left: 0, right: Math.max(8, window.innerWidth - rect.right) });
      }
    }
    setOpen(true);
  }, [align]);

  const handleTriggerClick = useCallback(() => {
    if (open) close();
    else openMenu();
  }, [open, openMenu, close]);

  // Close on outside click (check both trigger and portaled menu), scroll
  // (would detach the fixed menu from the trigger), resize, and Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      close();
    };
    const onReflow = () => close();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const positionStyle = align === 'left'
    ? { position: 'fixed', top: pos.top, left: pos.left, zIndex }
    : { position: 'fixed', top: pos.top, right: pos.right, zIndex };

  return (
    <>
      {renderTrigger({ ref: triggerRef, onClick: handleTriggerClick, open })}
      {open && createPortal(
        <div
          ref={menuRef}
          style={positionStyle}
          className={menuClassName || 'w-48 bg-surface rounded-xl border border-border shadow-lg py-1 overflow-hidden'}
        >
          {renderMenu({ close })}
        </div>,
        document.body
      )}
    </>
  );
}
