import "@testing-library/jest-dom/vitest";
import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  },
  close: {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  },
});

beforeEach(() => mockConvertFileSrc("linux"));
afterEach(() => {
  cleanup();
  clearMocks();
});
