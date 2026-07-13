/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type CatalogMenuElement = HTMLElement & { updateComplete: Promise<boolean> };

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("catalog session menu", () => {
  it("focuses the first item and traverses enabled items with arrow keys", async () => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    render(html`<openclaw-catalog-session-menu></openclaw-catalog-session-menu>`, container);
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it.each([
    [0, "viewer"],
    [1, "terminal"],
  ] as const)("dispatches item %s before synchronous close", async (index, expected) => {
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    let backingState: { open: true } | null = { open: true };
    const order: string[] = [];
    const onAction = vi.fn((action: CatalogSessionMenuAction) => {
      order.push(backingState ? action : "cleared");
    });
    render(
      html`<openclaw-catalog-session-menu
        .onAction=${onAction}
        .onClose=${() => {
          backingState = null;
          order.push("close");
        }}
      ></openclaw-catalog-session-menu>`,
      container,
    );
    const menu = container.querySelector("openclaw-catalog-session-menu") as CatalogMenuElement;
    await menu.updateComplete;

    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index]?.click();

    expect(onAction).toHaveBeenCalledWith(expected);
    expect(order).toEqual([expected, "close"]);
    expect(backingState).toBeNull();
  });
});
