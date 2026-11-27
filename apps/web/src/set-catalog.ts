import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export function useSetCatalog() {
  return useQuery({
    queryKey: ["scryfall-sets"],
    queryFn: () => api.listSets(),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
