import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import {
  type PrinterProfileInput,
  type PrintSettings,
  printSettingsSchema,
} from "./core/index.ts";
import { DuplexCalibration } from "./duplex-calibration.tsx";

it("applies, creates, updates and deletes profiles and exports the current correction", async () => {
  const existing = {
    id: "642f6d09-ae39-469b-980f-4ad95b52f3af",
    name: "Office laser",
    backOffsetXmm: 1.25,
    backOffsetYmm: -0.5,
    backRotationDeg: -0.3,
  };
  const newId = "ac57346f-8403-47a6-8be0-0c6411ffa07b";
  const destination = "/home/user/deckpress-duplex-calibration.pdf";
  const ipc = vi.fn((command: string, args?: unknown) => {
    switch (command) {
      case "list_printer_profiles":
        return [existing];
      case "save_printer_profile": {
        const { input, id } = args as {
          input: PrinterProfileInput;
          id: string | null;
        };
        return { ...input, id: id ?? newId };
      }
      case "plugin:dialog|save":
        return destination;
      case "plugin:dialog|message":
        return "Delete profile";
    }
  });
  mockIPC(ipc);
  function Harness() {
    const [settings, setSettings] = useState(() =>
      printSettingsSchema.parse({ backs: "short-edge" }),
    );
    return (
      <DuplexCalibration
        settings={settings}
        backs={settings.backs}
        onChange={(patch: Partial<PrintSettings>) =>
          setSettings((current) => ({ ...current, ...patch }))
        }
      />
    );
  }
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const status = screen.getByRole("status", {
    name: "Duplex calibration status",
  });
  expect(status).toBeEmptyDOMElement();
  const announcements: string[] = [];
  const observer = new MutationObserver(() => {
    const text = status.textContent;
    if (text) announcements.push(text);
  });
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  await screen.findByRole("option", { name: "Office laser" });
  const profile = screen.getByRole("combobox", { name: "Printer profile" });
  await user.selectOptions(profile, existing.id);
  const rotation = screen.getByRole("spinbutton", { name: /Back rotation/ });
  expect(rotation).toHaveValue(-0.3);
  expect(
    screen.getByRole("spinbutton", { name: /Back horizontal offset/ }),
  ).toHaveValue(1.25);
  expect(
    screen.getByRole("spinbutton", { name: /Back vertical offset/ }),
  ).toHaveValue(-0.5);

  fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), {
    target: { value: "Photo paper" },
  });
  fireEvent.change(rotation, { target: { value: "0.24" } });
  await user.click(screen.getByRole("button", { name: "Save as profile" }));
  await screen.findByRole("option", { name: "Photo paper" });
  const correction = {
    backOffsetXmm: 1.25,
    backOffsetYmm: -0.5,
    backRotationDeg: 0.24,
  };
  expect(ipc).toHaveBeenCalledWith("save_printer_profile", {
    id: null,
    input: { name: "Photo paper", ...correction },
  });

  fireEvent.change(screen.getByRole("textbox", { name: "Profile name" }), {
    target: { value: "Heavy stock" },
  });
  await user.click(screen.getByRole("button", { name: "Update profile" }));
  await screen.findByRole("option", { name: "Heavy stock" });
  expect(ipc).toHaveBeenCalledWith("save_printer_profile", {
    id: newId,
    input: { name: "Heavy stock", ...correction },
  });
  await user.click(screen.getByRole("button", { name: "Delete profile" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Current correction kept",
  );
  expect(ipc).toHaveBeenCalledWith("delete_printer_profile", { id: newId });
  expect(
    screen.queryByRole("option", { name: "Heavy stock" }),
  ).not.toBeInTheDocument();
  expect(rotation).toHaveValue(0.24);

  await user.click(
    screen.getByRole("button", { name: "Export calibration sheet" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Duplex calibration sheet saved",
  );
  expect(ipc).toHaveBeenCalledWith("save_duplex_calibration", {
    destination,
    settings: expect.objectContaining({ backs: "short-edge", ...correction }),
  });
  const firstMessage = status.firstElementChild;
  expect(firstMessage).toHaveTextContent("Duplex calibration sheet saved.");
  await user.click(
    screen.getByRole("button", { name: "Export calibration sheet" }),
  );
  expect(status.firstElementChild).toHaveTextContent(
    "Duplex calibration sheet saved.",
  );
  expect(status.firstElementChild).not.toBe(firstMessage);
  observer.disconnect();
  expect(screen.getAllByRole("status")).toEqual([status]);
  expect(announcements).toEqual([
    "Printer profile saved.",
    "Printer profile updated.",
    "Printer profile deleted. Current correction kept.",
    "Duplex calibration sheet saved.",
    "Duplex calibration sheet saved.",
  ]);
});

it("restores the selected id even with equal profiles and updates only that id after editing", async () => {
  const profile = {
    id: "642f6d09-ae39-469b-980f-4ad95b52f3af",
    name: "Office laser",
    backOffsetXmm: 1.25,
    backOffsetYmm: -0.5,
    backRotationDeg: -0.3,
  };
  const duplicate = {
    ...profile,
    id: "281d5f22-7f96-44c6-a06a-13ba60cba389",
    name: "Duplicate",
  };
  const other = {
    ...profile,
    id: "63e7451c-9dcc-4159-9ad2-f8e1b3b04b8b",
    name: "Other",
    backRotationDeg: 0.24,
  };
  const ipc = vi.fn((command, args) => {
    if (command === "list_printer_profiles") return [duplicate, other, profile];
    if (command === "save_printer_profile")
      return { ...args.input, id: args.id };
  });
  mockIPC(ipc);
  let persistedSettings = printSettingsSchema.parse({
    backOffsetXmm: profile.backOffsetXmm,
    backOffsetYmm: profile.backOffsetYmm,
    backRotationDeg: profile.backRotationDeg,
  });
  function Harness() {
    const [settings, setSettings] = useState(persistedSettings);
    return (
      <DuplexCalibration
        settings={settings}
        backs={settings.backs}
        onChange={(patch) => {
          persistedSettings = { ...settings, ...patch };
          setSettings(persistedSettings);
        }}
      />
    );
  }
  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
  const user = userEvent.setup();
  const before = mount();
  await screen.findByRole("option", { name: profile.name });
  const picker = () =>
    screen.getByRole("combobox", { name: "Printer profile" });
  expect(picker()).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Update profile" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  await user.selectOptions(picker(), profile.id);
  expect(persistedSettings.printerProfileId).toBe(profile.id);
  before.unmount();

  mount();
  await screen.findByRole("option", { name: profile.name });
  expect(picker()).toHaveValue(profile.id);
  expect(screen.getByRole("textbox", { name: "Profile name" })).toHaveValue(
    profile.name,
  );
  const rotation = screen.getByRole("spinbutton", { name: /Back rotation/ });
  fireEvent.change(rotation, { target: { value: "0.24" } });
  expect(picker()).toHaveDisplayValue("Custom correction");
  expect(screen.getByRole("button", { name: "Save as profile" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Update profile" })).toBeEnabled();
  fireEvent.blur(rotation);
  await user.selectOptions(picker(), profile.id);
  expect(picker()).toHaveValue(profile.id);
  expect(rotation).toHaveValue(-0.3);
  fireEvent.change(rotation, { target: { value: "0.24" } });
  await user.click(screen.getByRole("button", { name: "Update profile" }));
  expect(
    ipc.mock.calls.filter(([command]) => command === "save_printer_profile"),
  ).toEqual([
    [
      "save_printer_profile",
      {
        id: profile.id,
        input: {
          name: profile.name,
          backOffsetXmm: 1.25,
          backOffsetYmm: -0.5,
          backRotationDeg: 0.24,
        },
      },
    ],
  ]);
  expect(picker()).toHaveValue(profile.id);
  await user.selectOptions(picker(), "");
  expect(persistedSettings.printerProfileId).toBeUndefined();
  expect(rotation).toHaveValue(0.24);
  expect(
    screen.queryByRole("button", { name: "Update profile" }),
  ).not.toBeInTheDocument();
});

it("announces a deleted stored profile once and keeps the saved correction", async () => {
  const profiles = Promise.withResolvers<[]>();
  mockIPC((command) => {
    if (command === "list_printer_profiles") return profiles.promise;
  });
  function Harness() {
    const [settings, setSettings] = useState(() =>
      printSettingsSchema.parse({
        printerProfileId: "642f6d09-ae39-469b-980f-4ad95b52f3af",
        backOffsetXmm: 1.25,
      }),
    );
    return (
      <DuplexCalibration
        settings={settings}
        backs={settings.backs}
        onChange={(patch) =>
          setSettings((current) => ({ ...current, ...patch }))
        }
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  const status = screen.getByRole("status", {
    name: "Duplex calibration status",
  });
  expect(status).toBeEmptyDOMElement();
  profiles.resolve([]);
  const message = await screen.findByText(
    "Printer profile deleted. Current correction kept.",
  );
  expect(message).toBeVisible();
  expect(message).toBe(status.firstElementChild);
  expect(
    screen.getByRole("combobox", { name: "Printer profile" }),
  ).toHaveDisplayValue("Custom correction");
  expect(
    screen.queryByRole("button", { name: "Update profile" }),
  ).not.toBeInTheDocument();
  const offset = screen.getByRole("spinbutton", {
    name: /Back horizontal offset/,
  });
  expect(offset).toHaveValue(1.25);
  fireEvent.change(offset, { target: { value: "1.5" } });
  expect(status.firstElementChild).toBe(message);
});

it("announces a failed calibration export only as an alert", async () => {
  mockIPC((command) => {
    if (command === "list_printer_profiles") return [];
    if (command === "plugin:dialog|save") return "/home/user/calibration.pdf";
    if (command === "save_duplex_calibration")
      throw new Error("Could not save calibration sheet");
  });
  const settings = printSettingsSchema.parse({});
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DuplexCalibration
        settings={settings}
        backs={settings.backs}
        onChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Export calibration sheet" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save calibration sheet",
  );
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});
