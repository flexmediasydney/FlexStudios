import { useState, useMemo } from "react";

export function usePagination(items = [], itemsPerPage = 10) {
  const [currentPage, setCurrentPage] = useState(1);

  const pagination = useMemo(() => {
    const totalPages = Math.ceil(items.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const currentItems = items.slice(startIndex, endIndex);

    return {
      currentItems,
      currentPage,
      totalPages,
      totalItems: items.length,
      hasNextPage: currentPage < totalPages,
      hasPrevPage: currentPage > 1,
    };
  }, [items, itemsPerPage, currentPage]);

  return {
    ...pagination,
    goToPage: (page) => setCurrentPage(Math.max(1, Math.min(page, pagination.totalPages))),
    nextPage: () => pagination.hasNextPage && setCurrentPage(currentPage + 1),
    prevPage: () => pagination.hasPrevPage && setCurrentPage(currentPage - 1),
  };
}