import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ReconnectUploads } from "./reconnect-uploads.tsx";
import { storageQuotaError } from "./storage-quota.ts";
import { uploadHash } from "./upload-hash.ts";

afterEach(() => vi.unstubAllGlobals());

it("matches a renamed image by hash, another by filename, and allows manual assignment", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const user = userEvent.setup();
  const data = new Uint8Array([1]);
  const contentHash = await uploadHash(data);
  const makeFile = (name: string, bytes: Uint8Array<ArrayBuffer>) => {
    const file = new File([bytes], name, { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bytes.buffer,
    });
    return file;
  };
  const renamed = makeFile("renamed.png", data);
  const byName = makeFile("filename.png", new Uint8Array([2]));
  const manual = makeFile("original.png", new Uint8Array([3]));
  const wrong = makeFile("wrong.png", new Uint8Array([4]));
  const onRestore = vi.fn(async () => {});
  render(
    <ReconnectUploads
      missing={[
        { id: "hash", name: "Hash match", filename: manual.name, contentHash },
        { id: "name", name: "Filename match", filename: byName.name },
        { id: "manual", name: "Manual match" },
        {
          id: "mismatch",
          name: "Hash mismatch",
          filename: wrong.name,
          contentHash: "0".repeat(64),
        },
      ]}
      onClose={() => {}}
      onRestore={onRestore}
    />,
  );
  expect(screen.getByText(/4 uploads missing/)).toBeVisible();
  const picker = screen.getByLabelText<HTMLInputElement>(
    "Original image files",
  );
  const files = [manual, byName, renamed, wrong];
  await user.upload(picker, files);
  await waitFor(() => {
    expect(screen.getByText("Matched to renamed.png")).toBeVisible();
    expect(screen.getByText("Matched to filename.png")).toBeVisible();
  });
  expect(Array.from(picker.files ?? [])).toEqual(files);
  expect(screen.getByText("No matching file selected")).toBeVisible();
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  const override = screen.getByLabelText(/Hash mismatch/);
  expect(override).toHaveDisplayValue("Leave missing");
  expect(screen.queryByText(/different contents/)).not.toBeInTheDocument();
  await user.selectOptions(override, "3");
  expect(override).toHaveAccessibleDescription(
    "This file has different contents from the original. Restoring will use it as a replacement.",
  );
  expect(screen.getByLabelText(/Manual match/)).toHaveDisplayValue(
    "Leave missing",
  );
  await user.selectOptions(screen.getByLabelText(/Manual match/), "0");
  await user.click(
    screen.getByRole("button", { name: "Restore with selected files" }),
  );
  expect(onRestore).toHaveBeenCalledWith([
    { id: "hash", file: renamed },
    { id: "name", file: byName },
    { id: "manual", file: manual },
    { id: "mismatch", file: wrong, allowHashMismatch: true },
  ]);
});

it("describes a quota error with browser usage and the cache control", async () => {
  vi.stubGlobal("navigator", {
    storage: {
      estimate: async () => ({ usage: 23000000, quota: 24000000 }),
    },
  });
  const detail = await storageQuotaError(
    new DOMException("", "QuotaExceededError"),
  );
  expect(detail).toMatchObject({
    message:
      "Browser storage is full. Using about 23 MB of 24 MB. Go to Settings → Browser storage → Clear cache, then try again.",
  });
  const unrelated = new Error("Cannot decode this image");
  expect(await storageQuotaError(unrelated)).toBe(unrelated);
});
