(() => {
  const key = "deckpress.theme";
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const { dataset } = document.documentElement;
  const initial = window.deckpressInitialAppearance;
  let preference = initial ?? "system";
  if (initial === undefined) {
    try {
      const saved = localStorage.getItem(key);
      if (saved === "light" || saved === "dark") preference = saved;
    } catch {
      // Use System if local storage is unavailable.
    }
  }

  function apply() {
    dataset.theme =
      preference === "system"
        ? systemDark.matches ? "dark" : "light"
        : preference;
  }

  apply();
  systemDark.addEventListener("change", apply);
  window.deckpressAppearance = {
    get preference() {
      return preference;
    },
    set(value) {
      preference = value;
      apply();
      if (window.isTauri) return;
      try {
        if (value === "system") localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // The current window still uses the chosen appearance.
      }
    },
  };
})();
