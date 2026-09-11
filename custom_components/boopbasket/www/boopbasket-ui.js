window.BoopBasketUI = {
  showToast(card, msg, error = false) {
    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed", top: "24px", right: "24px", zIndex: "10000",
      background: error ? "var(--error-color)" : "var(--success-color)",
      color: "white", padding: "16px 24px", borderRadius: "8px", fontWeight: "500",
      fontSize: "14px", boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
      transform: "translateX(400px)", opacity: "0",
      transition: "all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
      maxWidth: "400px", wordWrap: "break-word"
    });
    toast.textContent = msg;
    
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.transform = "translateX(0)";
      toast.style.opacity = "1";
    });
    
    setTimeout(() => {
      toast.style.transform = "translateX(400px)";
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  shakeField(field) {
    field.style.borderColor = "var(--error-color)";
    field.style.boxShadow = "0 0 0 2px var(--error-color)";
    field.style.animation = "shake 0.5s ease-in-out";
    
    setTimeout(() => {
      field.style.borderColor = "";
      field.style.boxShadow = "";
      field.style.animation = "";
    }, 500);
  },

  // Shared native <dialog>/<button> chrome for every dialog in this card,
  // instead of <ha-dialog>/<ha-button>: those rely on custom-element
  // upgrade + internal slot rendering that can silently fail to mount the
  // slotted action buttons, and ha-dialog doesn't reliably expose a
  // .close() method the way a native <dialog> does. showModal()/the native
  // 'close' event give the same focus-trapping/backdrop/dismiss behavior
  // without that lifecycle to fight.
  _ensureDialogStyles() {
    if (document.getElementById('boopbasket-dialog-styles')) return;

    const style = document.createElement('style');
    style.id = 'boopbasket-dialog-styles';
    style.textContent = `
      .boopbasket-dialog {
        border: none;
        border-radius: 12px;
        padding: 16px;
        max-width: 420px;
        width: 90vw;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        box-shadow: var(--ha-dialog-box-shadow, 0 8px 24px rgba(0, 0, 0, 0.3));
      }
      .boopbasket-dialog::backdrop {
        background: rgba(0, 0, 0, 0.5);
      }
      .boopbasket-dialog-heading {
        font-size: 1.25em;
        font-weight: 500;
        margin-bottom: 8px;
        text-align: center;
      }
      .boopbasket-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
      .boopbasket-btn {
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 0.9em;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
      }
      .boopbasket-btn-primary {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .boopbasket-btn-secondary {
        background: transparent;
        color: var(--primary-color, #03a9f4);
      }
      .boopbasket-btn-danger {
        background: var(--error-color, #db4437);
        color: #fff;
      }
    `;
    document.head.appendChild(style);
  },

  // Appends a native <dialog> (heading + empty content/actions containers)
  // to <body> and hands the pieces back for the caller to fill in and
  // show. Not shown modal yet — caller calls .showModal() once ready.
  createDialogShell(title) {
    this._ensureDialogStyles();

    const dialog = document.createElement('dialog');
    dialog.className = 'boopbasket-dialog';

    const heading = document.createElement('div');
    heading.className = 'boopbasket-dialog-heading';
    heading.textContent = title;

    const content = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'boopbasket-dialog-actions';

    dialog.append(heading, content, actions);
    document.body.appendChild(dialog);

    return { dialog, content, actions };
  },

  // variant: 'primary' | 'secondary' | 'danger'
  createButton(text, variant = 'secondary') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `boopbasket-btn boopbasket-btn-${variant}`;
    btn.textContent = text;
    return btn;
  },

  async showDialog(card, title, contentHTML, onConfirm, confirmText = "Save", cancelText = "Cancel", isDanger = false) {
    return new Promise((resolve) => {
      const { dialog, content, actions } = this.createDialogShell(title);
      content.style.cssText = "text-align: left; padding: 1em 0;";
      content.innerHTML = contentHTML;

      const cancelBtn = this.createButton(cancelText, "secondary");
      cancelBtn.addEventListener("click", () => dialog.close());

      const confirmBtn = this.createButton(confirmText, isDanger ? "danger" : "primary");
      confirmBtn.addEventListener("click", async () => {
        console.log('[BoopBasket] confirm button clicked:', confirmText);
        try {
          await onConfirm(dialog);
          console.log('[BoopBasket] onConfirm resolved without throwing');
        } catch (e) {
          console.error('[BoopBasket] onConfirm threw:', e);
          this.showToast(card, `Error: ${e.message || e.body?.message || e}`, true);
          return;
        }
        dialog.close();
      });

      actions.append(cancelBtn, confirmBtn);

      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog);
      }, { once: true });

      dialog.showModal();
    });
  }
};
