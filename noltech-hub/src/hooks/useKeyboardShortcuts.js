import { useEffect } from 'react';

/**
 * Keyboard shortcuts hook for the arbitrage scanner.
 *
 * Shortcuts:
 *   b       — trigger quick bid on focused/hovered lot
 *   s       — toggle star/watchlist
 *   n       — toggle notes
 *   /       — focus search input
 *   Escape  — close modals/panels
 *
 * Callbacks are only fired when the user is NOT focused on an
 * input, textarea, or select element (to avoid hijacking typing).
 *
 * @param {{ onBid?: () => void, onStar?: () => void, onNotes?: () => void, onSearch?: () => void, onEscape?: () => void }} handlers
 */
export default function useKeyboardShortcuts({ onBid, onStar, onNotes, onSearch, onEscape } = {}) {
  useEffect(() => {
    function handleKeyDown(e) {
      // Never fire when user is typing in a form element
      const tag = document.activeElement?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable;

      // Escape should always work, even in inputs (to blur / close modals)
      if (e.key === 'Escape') {
        if (onEscape) {
          onEscape();
          e.preventDefault();
        }
        return;
      }

      // Skip all other shortcuts when focused on editable elements
      if (isEditable) return;

      // Don't fire if modifier keys are held (Ctrl, Alt, Meta) to avoid
      // conflicting with browser shortcuts
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      switch (e.key.toLowerCase()) {
        case 'b':
          if (onBid) {
            onBid();
            e.preventDefault();
          }
          break;
        case 's':
          if (onStar) {
            onStar();
            e.preventDefault();
          }
          break;
        case 'n':
          if (onNotes) {
            onNotes();
            e.preventDefault();
          }
          break;
        case '/':
          if (onSearch) {
            onSearch();
            e.preventDefault();
          }
          break;
        default:
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onBid, onStar, onNotes, onSearch, onEscape]);
}
