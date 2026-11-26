import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { type MenuAction, MenuButton } from "./export-menu.tsx";

function setup() {
  const png = vi.fn();
  const mpc = vi.fn();
  const svg = vi.fn();
  const items: MenuAction[] = [
    { id: "png", label: "PNG ZIP", hint: "PNGs", icon: null, onSelect: png },
    {
      id: "mpc",
      label: "MPC Autofill XML",
      hint: "Order",
      icon: null,
      disabledReason: "Add cards to the deck first.",
      onSelect: mpc,
    },
    {
      id: "svg",
      label: "SVG cut template",
      hint: "Cut",
      icon: null,
      onSelect: svg,
    },
  ];
  render(
    <>
      <MenuButton label="Other exports" items={items} />
      <button type="button">After</button>
    </>,
  );
  const button = screen.getByRole("button", { name: "Other exports" });
  return { button, png, mpc, svg, user: userEvent.setup() };
}
const item = (name: string) => screen.getByRole("menuitem", { name });

it("opens with Enter and moves with arrows, Home and End", async () => {
  const { button, user } = setup();
  expect(button).toHaveAttribute("aria-haspopup", "menu");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  button.focus();
  await user.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menu", { name: "Other exports" })).toBeVisible();
  expect(button).toHaveAttribute("aria-controls", screen.getByRole("menu").id);
  expect(item("PNG ZIP")).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(item("MPC Autofill XML")).toHaveFocus();
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(item("PNG ZIP")).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(item("SVG cut template")).toHaveFocus();
  await user.keyboard("{Home}");
  expect(item("PNG ZIP")).toHaveFocus();
  await user.keyboard("{End}");
  expect(item("SVG cut template")).toHaveFocus();
});

it("opens on the first or last item with ArrowDown or ArrowUp", async () => {
  const { button, user } = setup();
  button.focus();
  await user.keyboard("{ArrowUp}");
  expect(item("SVG cut template")).toHaveFocus();
  await user.keyboard("{Escape}");
  await user.keyboard("{ArrowDown}");
  expect(item("PNG ZIP")).toHaveFocus();
});

it("closes with Escape and returns focus to the button", async () => {
  const { button, png, user } = setup();
  button.focus();
  await user.keyboard("{Enter}{ArrowDown}{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("data-focus-return");
  expect(png).not.toHaveBeenCalled();
  await user.tab();
  expect(button).not.toHaveAttribute("data-focus-return");
});

it("closes on Tab and lets focus move on", async () => {
  const { button, user } = setup();
  button.focus();
  await user.keyboard("{Enter}");
  await user.tab();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}{Shift>}{Tab}{/Shift}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(document.body).toHaveFocus();
});

it("dispatches the chosen item with Enter or a click and refocuses the button", async () => {
  const { button, png, svg, user } = setup();
  button.focus();
  await user.keyboard("{Enter}{End}{Enter}");
  expect(svg).toHaveBeenCalledOnce();
  expect(png).not.toHaveBeenCalled();
  expect(button).toHaveFocus();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(button);
  await user.click(item("PNG ZIP"));
  expect(png).toHaveBeenCalledOnce();
  expect(svg).toHaveBeenCalledOnce();
});

it("keeps a disabled item focusable, shows why, and does not run it", async () => {
  const { button, mpc, user } = setup();
  button.focus();
  await user.keyboard("{Enter}{ArrowDown}");
  const disabled = item("MPC Autofill XML");
  expect(disabled).toHaveFocus();
  expect(disabled).toHaveAttribute("aria-disabled", "true");
  expect(disabled).toHaveAccessibleDescription("Add cards to the deck first.");
  expect(screen.getByText("Add cards to the deck first.")).toBeVisible();
  await user.keyboard("{Enter}");
  await user.click(disabled);
  expect(mpc).not.toHaveBeenCalled();
  expect(disabled).toHaveFocus();
  expect(item("PNG ZIP")).toHaveAccessibleDescription("PNGs");
});

it("closes when clicking outside", async () => {
  const { button, user } = setup();
  await user.click(button);
  expect(screen.getByRole("menu")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "After" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
