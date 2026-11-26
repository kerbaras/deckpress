import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { showThemedWindow } from "./startup-window.ts";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

let didRequestReveal = false;

function DesktopApp() {
  useEffect(() => {
    if (!isTauri() || didRequestReveal) return;
    didRequestReveal = true;
    void showThemedWindow().catch(console.error);
  }, []);

  return <App />;
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DesktopApp />
    </QueryClientProvider>
  </StrictMode>,
);
