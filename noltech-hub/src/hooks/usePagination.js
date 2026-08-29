// ─── Pagination Hook ──────────────────────────────────────────────────────────
// Generic hook for paginating any array of items.

import { useState, useMemo, useCallback } from 'react';

/**
 * @param {any[]} items - Full array to paginate
 * @param {number} [pageSize=25] - Items per page
 * @returns {{ page, pageItems, totalPages, next, prev, setPage, setPageSize, pageSize }}
 */
export default function usePagination(items, initialPageSize = 25) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSizeState] = useState(initialPageSize);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((items?.length || 0) / pageSize)),
    [items?.length, pageSize]
  );

  // Clamp page when items change
  const safePage = Math.min(page, totalPages - 1);

  const pageItems = useMemo(
    () => (items || []).slice(safePage * pageSize, (safePage + 1) * pageSize),
    [items, safePage, pageSize]
  );

  const next = useCallback(() => setPage(p => Math.min(p + 1, totalPages - 1)), [totalPages]);
  const prev = useCallback(() => setPage(p => Math.max(p - 1, 0)), []);

  const setPageSize = useCallback((size) => {
    setPageSizeState(size);
    setPage(0);
  }, []);

  return {
    page: safePage,
    pageItems,
    totalPages,
    next,
    prev,
    setPage,
    setPageSize,
    pageSize,
  };
}
