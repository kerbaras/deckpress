import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function showThemedWindow() {
  const window = getCurrentWebviewWindow();
  const canvas = getComputedStyle(document.documentElement)
    .getPropertyValue("--canvas")
    .trim();
  await window.setBackgroundColor(canvas);
  await window.show();
}
