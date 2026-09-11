window.BoopBasketTable = {
  _lastClick: null,

  render(card, data, shoppingItems = new Set()) {
    if (!Object.keys(data).length) {
      card._content.innerHTML = "<p style='text-align: center; color: var(--secondary-text-color); padding: 2em;'>No mappings found</p>";
      card._updateBulkActions(0);
      return;
    }

    const sortedEntries = Object.entries(data).sort(([a], [b]) => b.localeCompare(a));

    let html = `
      <div class="barcode-table-wrapper" style="width: 100%; overflow-x: auto; padding: 0; margin: 0;">
        <table class="barcode-table" style="width: 100%; border-collapse: collapse;">
          <colgroup>
            <col style="width: 48px;">
            <col style="width: 1fr;">
            <col style="width: 88px;">
            <col style="width: 120px;">
          </colgroup>
          <thead>
            <tr>
              <th style="width: 48px;text-align: left;"><ha-checkbox id="select-all"></ha-checkbox></th>
              <th style="text-align: left;>Product</th>
              <th style="text-align: center; width: 88px;">Stock</th>
              <th style="text-align: center; min-width: 100px;">Actions</th>
            </tr>
          </thead>
          <tbody>`;

    sortedEntries.forEach(([barcode, entry]) => {
      const name = entry.name;
      const inShoppingList = shoppingItems.has(name.toLowerCase());
      const stock = entry.stock ?? entry.quantity ?? 0;

      html += `
        <tr data-barcode="${barcode}">
          <td style="width: 48px;"><ha-checkbox data-barcode="${barcode}"></ha-checkbox></td>
          <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 8px;">
            ${name} ${inShoppingList ? '<span style="color: var(--success-color); font-size: 0.8em;">✓</span>' : ''}
          </td>
          <td style="text-align: center;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 2px;">
              <ha-icon-button data-action="stock-dec" data-barcode="${barcode}" title="Decrease stock" style="--mdc-icon-button-size: 24px;">
                <ha-icon icon="mdi:minus"></ha-icon>
              </ha-icon-button>
              <span style="min-width: 1.5em; display: inline-block; ${stock === 0 ? 'color: var(--error-color); font-weight: bold;' : ''}">${stock}</span>
              <ha-icon-button data-action="stock-inc" data-barcode="${barcode}" title="Increase stock" style="--mdc-icon-button-size: 24px;">
                <ha-icon icon="mdi:plus"></ha-icon>
              </ha-icon-button>
            </div>
          </td>
          <td style="text-align: right; min-width: 100px; padding-right: 4px;">
            <div class="action-buttons" style="display: flex; gap: 2px; justify-content: flex-end; flex-wrap: nowrap; min-width: 64px;">
              <ha-icon-button data-action="edit" data-barcode="${barcode}" title="Edit" style="--mdc-icon-button-size: 28px;">
                <ha-icon icon="mdi:pencil"></ha-icon>
              </ha-icon-button>
              <ha-icon-button data-action="delete" data-barcode="${barcode}" title="Delete" style="--mdc-icon-button-size: 28px;">
                <ha-icon icon="mdi:delete"></ha-icon>
              </ha-icon-button>
            </div>
          </td>
        </tr>`;
    });

    html += `</tbody></table></div>`;
    card._content.innerHTML = html;
    this._setupEventHandlers(card, data);
  },

  _setupEventHandlers(card, data) {
    card._content.addEventListener('change', e => {
      if (e.target.tagName !== 'HA-CHECKBOX') return;
      const barcode = e.target.dataset.barcode;
      const checked = e.target.checked;

      if (e.target.id === 'select-all') {
        Object.keys(data).forEach(b => (card._selected[b] = checked));
        this._updateAllCheckboxes(card._content, data, checked);
      } else if (barcode) {
        card._selected[barcode] = checked;
        this._updateSelectAllState(card._content, data);
      }
      card._updateBulkActions(Object.values(card._selected).filter(Boolean).length);
    });

    card._content.addEventListener(
      'click',
      async e => {
        const button = e.target.closest('ha-icon-button');
        if (!button || !button.dataset.barcode) return;

        const barcode = button.dataset.barcode;
        const action = button.dataset.action;
        const clickKey = `${barcode}:${action}`;

        if (this._lastClick === clickKey) return;
        this._lastClick = clickKey;
        setTimeout(() => {
          this._lastClick = null;
        }, 500);

        e.preventDefault();
        e.stopPropagation();

        if (action === 'edit') {
          card._showEditDialog(barcode, data[barcode]);
        } else if (action === 'delete') {
          card._showDeleteDialog(barcode, data[barcode]);
        } else if (action === 'stock-inc') {
          card._adjustStock(barcode, 1);
        } else if (action === 'stock-dec') {
          card._adjustStock(barcode, -1);
        }
      },
      { passive: false }
    );

    const bulkDelete = card._bulkActions.querySelector('#bulk-delete');
    if (bulkDelete) {
      bulkDelete.replaceWith(bulkDelete.cloneNode(true));
      card._bulkActions
        .querySelector('#bulk-delete')
        .addEventListener('click', () => card._deleteSelected());
    }
  },

  _updateAllCheckboxes(content, data, checked) {
    Object.keys(data).forEach(barcode => {
      const cb = content.querySelector(`ha-checkbox[data-barcode="${barcode}"]`);
      if (cb) cb.checked = checked;
    });
  },

  _updateSelectAllState(content, data) {
    const selectAll = content.querySelector('#select-all');
    if (!selectAll) return;
    const checkboxes = content.querySelectorAll('ha-checkbox[data-barcode]');
    const total = checkboxes.length;
    const checked = Array.from(checkboxes).filter(cb => cb.checked).length;
    selectAll.checked = checked === total;
    selectAll.indeterminate = checked > 0 && checked < total;
  }
};
