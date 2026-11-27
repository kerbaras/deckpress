import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { isWebPreview } from "./api.ts";
import { App } from "./app.tsx";
import { migrateAppearance, showThemedWindow } from "./startup-window.ts";
import { registerWebApp } from "./web/pwa/register.ts";
import "./styles.css";

const web = isWebPreview();
const local = web ? { networkMode: "always" as const } : {};
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, ...local },
    mutations: local,
  },
});

if (import.meta.env.PROD && import.meta.env.VITE_TARGET === "web")
  void registerWebApp();

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

let didRequestReveal = false;

function DesktopApp() {
  useEffect(() => {
    if (!isTauri() || didRequestReveal) return;
    didRequestReveal = true;
    void migrateAppearance().catch(console.error);
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
