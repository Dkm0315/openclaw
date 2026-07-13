import { html } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";

export type CatalogSessionMenuAction = "viewer" | "terminal";

class CatalogSessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) terminalDisabled = false;
  @property({ attribute: false }) onAction: (action: CatalogSessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    promoteToPopoverTopLayer(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    this.enabledItems()[0]?.focus();
  }

  private enabledItems(): HTMLButtonElement[] {
    return [...this.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.querySelector(".session-menu");
    if ((menu && path.includes(menu)) || (this.trigger && path.includes(this.trigger))) {
      return;
    }
    this.onClose();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.trigger?.focus();
      this.onClose();
      return;
    }
    const items = this.enabledItems();
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") {
      next = (current + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = current <= 0 ? items.length - 1 : current - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    } else if (event.key === "Enter" && current >= 0) {
      event.preventDefault();
      items[current]?.click();
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  };

  private run(action: CatalogSessionMenuAction) {
    // Dispatch while the controller still owns the menu snapshot; close clears it synchronously.
    this.onAction(action);
    this.onClose();
  }

  override render() {
    const x = Math.max(8, Math.min(this.x, window.innerWidth - 248));
    const y = Math.max(8, Math.min(this.y, window.innerHeight - 112));
    return html`
      <div
        class="session-menu"
        role="menu"
        aria-label=${t("chat.catalog.sessionMenu")}
        style="left: ${x}px; top: ${y}px;"
      >
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          @click=${() => this.run("viewer")}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.messageSquare}</span>
          <span class="session-menu__text">${t("chat.catalog.openInOpenClaw")}</span>
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          title=${this.terminalDisabled ? t("chat.catalog.terminalUnavailable") : ""}
          ?disabled=${this.terminalDisabled}
          @click=${() => this.run("terminal")}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.terminal}</span>
          <span class="session-menu__text">${t("chat.catalog.openInTerminal")}</span>
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-catalog-session-menu")) {
  customElements.define("openclaw-catalog-session-menu", CatalogSessionMenu);
}
