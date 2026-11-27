import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api.ts";

export function useSetCatalog() {
  const catalog = useQuery({
    queryKey: ["scryfall-sets"],
    queryFn: () => api.listSets(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnReconnect: false,
  });
  const { isError, refetch } = catalog;
  useEffect(() => {
    if (!isError) return;
    const retry = () => void refetch({ cancelRefetch: false });
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [isError, refetch]);
  return catalog;
}
