import { useSetCatalog } from "./set-catalog.ts";

export type UseSet = (set: string, opener: HTMLButtonElement) => void;

export function UseSetAction({
  set,
  disabled,
  onUseSet,
}: {
  set: string;
  disabled: boolean;
  onUseSet: UseSet;
}) {
  const catalog = useSetCatalog();
  const name = catalog.data?.find(({ code }) => code === set)?.name;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => onUseSet(set, event.currentTarget)}
    >
      Use {name ?? set.toUpperCase()} for the whole deck
    </button>
  );
}
