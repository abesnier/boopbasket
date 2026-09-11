class BoopBasketCard extends HTMLElement {
  _refreshTimeout = null;
  _refreshPending = false;
  _initialized = false;
  _unsubCache = null;
  _allData = null;
  _selected = {};
  _hass = null;
  _shoppingItems = new Set();
  _lastShoppingHash = '';
  _lastShoppingState = null;
  _todoEntity = null;

  set hass(hass) {
    // this._todoEntity is fetched async from the backend (whatever todo
    // list was actually chosen in config flow — see _fetchTodoEntity), so
    // it may still be null on early hass updates; that's fine, it just
    // means this particular state-changed shortcut is skipped until it's
    // known, same as _subscribeUpdates() below.
    const oldShoppingState = this._todoEntity ? this._hass?.states?.[this._todoEntity] : null;
    this._hass = hass;

    if (!this._initialized) {
      this._initialized = true;
      this._loadModules().then(async () => {
        this._build();
        await this._fetchTodoEntity();
        this._subscribeUpdates();
        setTimeout(() => this._debouncedRefresh(), 100);
      });
    } else if (this._todoEntity) {
      const newShoppingState = hass.states?.[this._todoEntity];
      if (
        newShoppingState &&
        oldShoppingState &&
        (oldShoppingState.state !== newShoppingState.state ||
          oldShoppingState.last_changed !== newShoppingState.last_changed)
      ) {
        this._debouncedRefresh();
      }
    }
  }

  // Learns which todo list entity was actually chosen in the integration's
  // config flow, instead of assuming the built-in todo.shopping_list —
  // that assumption broke checkmarks/live-refresh for anyone who linked a
  // different list. Non-fatal on failure: the card still works, just
  // without the "already on list" checkmarks (see _debouncedRefresh).
  async _fetchTodoEntity() {
    try {
      const cfg = await this._hass.callApi('GET', 'boopbasket/config');
      this._todoEntity = cfg.todo_entity || null;
    } catch {
      this._todoEntity = null;
    }
  }

  async _subscribeUpdates() {
    if (this._unsubCache) {
      this._unsubCache();
      this._unsubCache = null;
    }

    if (!this._todoEntity) return;

    this._unsubCache = this._hass.connection.subscribeEvents(
      async (event) => {
        if (
          event.event_type === 'state_changed' &&
          event.data?.entity_id === this._todoEntity
        ) {
          await this._debouncedRefresh();
        }
      },
      'state_changed'
    );
  }

  disconnectedCallback() {
    if (typeof this._unsubCache === 'function') {
      this._unsubCache();
      this._unsubCache = null;
    }

    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }

    if (window.BoopBasketTable?._refreshTimeout) {
      clearTimeout(window.BoopBasketTable._refreshTimeout);
    }
  }

  async _loadModules() {
    if (!window.BoopBasketTable) {
      // Cache-bust: these are fetched via a fixed <script src>, so once a
      // browser caches one of these files, editing boopbasket-camera/
      // table/ui.js on disk has no effect for returning users until they
      // manually clear their cache. Bump MODULE_VERSION whenever any of
      // the three change. Served from the integration's own static path
      // (registered in __init__.py), not a manually-added Lovelace
      // resource.
      const v = BoopBasketCard.MODULE_VERSION;
      await Promise.all([
        this._loadScript(`/boopbasket_static/boopbasket-camera.js?v=${v}`),
        this._loadScript(`/boopbasket_static/boopbasket-table.js?v=${v}`),
        this._loadScript(`/boopbasket_static/boopbasket-ui.js?v=${v}`),
      ]);
    }
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  _build() {
    const card = document.createElement('ha-card');
    card.header = 'BoopBasket';
    //card.style.padding = '1em';

    const cardRow = document.createElement('div');
    cardRow.style.paddingLeft = '16px';
    cardRow.style.paddingRight = '16px';
    cardRow.style.paddingBottom = '0px';
    cardRow.style.paddingTop = '16px';

    const inputContainer = document.createElement('div');
    inputContainer.style.cssText = `
    position: relative;
    width: 100%;
    margin-bottom: 1em;
  `;

    // Plain <input>, not ha-textfield: ha-textfield is a Home Assistant
    // custom element that only renders once its module has been lazy-loaded
    // by the frontend, which isn't guaranteed on every dashboard/panel — an
    // un-upgraded instance sits in the DOM with no shadow root and reports
    // zero size everywhere. Same failure class as the ha-dialog/ha-button
    // issue already worked around in boopbasket-camera.js.
    this._barcodeField = document.createElement('input');
    this._barcodeField.type = 'text';
    this._barcodeField.placeholder = 'Scan or add barcode';
    this._barcodeField.className = 'boopbasket-input';
    this._barcodeField.style.paddingRight = '92px';

    const quickAddBtn = document.createElement('ha-icon-button');
    quickAddBtn.title = 'Add';
    quickAddBtn.style.cssText = `
    position: absolute;
    right: 52px;
    top: 50%;
    transform: translateY(-50%);
    --mdc-icon-button-size: 32px;
    pointer-events: auto;
    z-index: 1;
  `;
    const plusIcon = document.createElement('ha-icon');
    plusIcon.icon = 'mdi:plus';
    quickAddBtn.appendChild(plusIcon);
    quickAddBtn.addEventListener('click', () => this._addQuick());

    const scanBtn = document.createElement('ha-icon-button');
    scanBtn.title = 'Scan';
    scanBtn.style.cssText = `
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    --mdc-icon-button-size: 32px;
    pointer-events: auto;
    z-index: 1;
  `;
    const cameraIcon = document.createElement('ha-icon');
    cameraIcon.icon = 'mdi:camera';
    scanBtn.appendChild(cameraIcon);
    scanBtn.addEventListener('click', () => BoopBasketCamera.openScanner(this));

    inputContainer.append(this._barcodeField, quickAddBtn, scanBtn);

    this._searchField = document.createElement('input');
    this._searchField.type = 'text';
    this._searchField.placeholder = 'Search barcode or product';
    this._searchField.className = 'boopbasket-input';
    this._searchField.style.marginBottom = '1em';
    this._searchField.addEventListener('input', () => this._filterTable());

    this._bulkActions = document.createElement('div');
    this._bulkActions.style.cssText =
      'display: flex; gap: 1em; margin-bottom: 1em; align-items: center;';

    const bulkCount = document.createElement('span');
    bulkCount.style.cssText = 'font-size: 0.9em; color: var(--secondary-text-color);';
    bulkCount.textContent = '0 selected';

    // BoopBasketUI.createButton(), not <ha-button>: see the note above on
    // _barcodeField for why ha-* custom elements can't be relied on to
    // render when assembled imperatively like this.
    const bulkDeleteBtn = BoopBasketUI.createButton('Delete Selected', 'danger');
    bulkDeleteBtn.id = 'bulk-delete';
    bulkDeleteBtn.disabled = true;

    this._bulkActions.append(bulkCount, bulkDeleteBtn);

    this._content = document.createElement('div');
    this._content.className = 'barcode-table-wrapper';
    this._content.innerHTML = '<p>Loading…</p>';

    // ✅ Export button BELOW table
    this._exportContainer = document.createElement('div');
    this._exportContainer.style.cssText = `
    display: flex;
    justify-content: center;
    margin-top: 1em;
    padding-top: 1em;
    border-top: 1px solid var(--divider-color);
  `;
    const exportBtn = BoopBasketUI.createButton('📤 Export Data', 'primary');
    exportBtn.addEventListener('click', () => this._exportData());
    this._exportContainer.appendChild(exportBtn);
    cardRow.append(inputContainer, this._searchField, this._bulkActions, this._content, this._exportContainer);
    card.append(cardRow);
    this.innerHTML = '';
    this.append(card);

    this._initStyles();
  }

  _initStyles() {
    if (document.getElementById('barcode-final')) return;

    const style = document.createElement('style');
    style.id = 'barcode-final';
    style.textContent = `
      .barcode-table-wrapper {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .barcode-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      .barcode-table col:nth-child(1) { width: 48px; }
      .barcode-table col:nth-child(2) { width: auto; }
      .barcode-table col:nth-child(3) { width: 88px; }
      .barcode-table col:nth-child(4) { width: 120px; }

      .barcode-table tbody tr {
        transition: background-color 150ms ease;
      }

      .barcode-table tbody tr:hover {
        background: rgba(var(--primary-color-rgb), 0.04);
      }

      .barcode-table td {
        vertical-align: middle;
        padding: 8px 4px;
        overflow: hidden;
      }

      .action-buttons {
        display: flex;
        gap: 2px;
        justify-content: flex-end;
        flex-wrap: nowrap;
        min-width: 64px;
      }

      @media (min-width: 800px) {
        .barcode-table { min-width: 600px; }
        .barcode-table col:nth-child(4) { width: 160px; }
      }

      @media (min-width: 500px) {
        .barcode-table { min-width: 480px; }
        .barcode-table col:nth-child(4) { width: 120px; }
      }

      @media (max-width: 499px) {
        .barcode-table { min-width: 420px; }
        .barcode-table col:nth-child(4) { width: 96px; }
      }

      .boopbasket-input {
        box-sizing: border-box;
        width: 100%;
        height: 56px;
        padding: 16px;
        font-size: 1em;
        font-family: inherit;
        color: var(--primary-text-color, #000);
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 4px;
      }

      .boopbasket-input:focus {
        outline: none;
        border-color: var(--primary-color, #03a9f4);
      }
    `;
    document.head.appendChild(style);
  }

  async _debouncedRefresh() {
    if (this._refreshPending) {
      clearTimeout(this._refreshTimeout);
    }
    this._refreshPending = true;

    this._refreshTimeout = setTimeout(async () => {
      try {
        const data = await this._hass.callApi('GET', 'boopbasket/mappings');
        this._allData = data;
        this._selected = {};

        // Whatever todo list was actually linked at setup — not the
        // legacy 'shopping_list' REST endpoint, which only ever reflects
        // the built-in Shopping List integration regardless of what was
        // configured. todo.get_items items use {summary, status}, not the
        // old {name, complete} shape.
        if (!this._todoEntity) await this._fetchTodoEntity();
        if (this._todoEntity) {
          try {
            const result = await this._hass.callService(
              'todo', 'get_items', {}, { entity_id: this._todoEntity }, true, true
            );
            const items = result?.response?.[this._todoEntity]?.items ?? [];
            const pendingItems = items.filter((item) => item.status === 'needs_action');
            this._shoppingItems = new Map(
              pendingItems.map((item) => [item.summary.toLowerCase().trim(), item])
            );
          } catch (err) {
            console.warn('[BoopBasket] todo.get_items failed, checkmarks disabled:', err);
            this._shoppingItems = new Map();
          }
        } else {
          this._shoppingItems = new Map();
        }

        BoopBasketTable.render(this, data, this._shoppingItems);
      } catch (err) {
        this._content.innerHTML = `<p style="color:var(--error-color)">Error: ${err.message}</p>`;
      } finally {
        this._refreshPending = false;
      }
    }, 800);
  }

  _filterTable() {
    const term = this._searchField.value.toLowerCase();
    this._selected = {};
    const filtered = {};
    Object.entries(this._allData || {}).forEach(([k, v]) => {
      if (k.includes(term) || (v.name && v.name.toLowerCase().includes(term))) {
        filtered[k] = v;
      }
    });
    BoopBasketTable.render(this, filtered, this._shoppingItems);
  }

  _exportData() {
    if (!this._allData) return;
    const blob = new Blob([JSON.stringify(this._allData, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `barcode_mappings_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    BoopBasketUI.showToast(this, 'Data exported');
  }

  async _addQuick() {
    const barcode = this._barcodeField.value.trim();
    if (!barcode) {
      BoopBasketUI.shakeField(this._barcodeField);
      return BoopBasketUI.showToast(this, 'Enter barcode first', true);
    }

    BoopBasketUI.showToast(this, 'Looking up product...');

    let suggestedData = { name: barcode };
    let showAutoFill = false;

    try {
      const lookup = await this._hass.callApi('GET', `boopbasket/lookup/${barcode}`);
      if (lookup && !lookup.error) {
        suggestedData = lookup;
        showAutoFill = true;
      }
    } catch { }

    // Pre-fill with this barcode's current stock (+1, since scanning/
    // adding means restocking) if it's already mapped, or start at 1 for
    // a brand-new one.
    const existing = this._allData?.[barcode];
    const currentStock = existing?.stock ?? existing?.quantity ?? 0;
    const currentThreshold = existing?.low_stock_threshold ?? 0;

    await BoopBasketUI.showDialog(
      this,
      'Add Product',
      `
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Barcode</label>
            <input class="boopbasket-input" id="barcodeField" value="${barcode}" readOnly style="font-family: monospace;" />
          </div>
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Product Name *</label>
            <input class="boopbasket-input" id="nameField" value="${suggestedData.name}" dialogInitialFocus />
          </div>
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Stock</label>
            <input class="boopbasket-input" id="stockField" type="number" min="0" step="1" value="${currentStock + 1}" />
          </div>
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Low Stock Threshold</label>
            <input class="boopbasket-input" id="thresholdField" type="number" min="0" step="1" value="${currentThreshold}" />
          </div>
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Package Size</label>
            <input class="boopbasket-input" id="packageSizeField" value="${suggestedData.package_size || ''}" placeholder="Optional" />
          </div>
          <div>
            <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Brands</label>
            <input class="boopbasket-input" id="brandsField" value="${suggestedData.brands || ''}" placeholder="Optional" />
          </div>
          ${showAutoFill ? '<div style="font-size: 0.85em; color: var(--success-color); padding: 12px; background: rgba(0,255,0,0.1); border-radius: 4px; margin-top: 8px;">Auto-filled from OpenFoodFacts</div>' : ''}
        </div>
      `,
      async (dialog) => {
        const nameField = dialog.querySelector('#nameField');
        const stockField = dialog.querySelector('#stockField');
        const thresholdField = dialog.querySelector('#thresholdField');
        const packageSizeField = dialog.querySelector('#packageSizeField');
        const brandsField = dialog.querySelector('#brandsField');
        console.log('[BoopBasket] _addQuick onConfirm: fields found?', {
          nameField: !!nameField,
          stockField: !!stockField,
          thresholdField: !!thresholdField,
          packageSizeField: !!packageSizeField,
          brandsField: !!brandsField,
        });

        const name = nameField.value.trim();
        if (!name) return BoopBasketUI.showToast(this, 'Name required', true);

        const serviceData = {
          code: barcode,
          product_name: name,
          brands: brandsField.value.trim(),
          stock: parseInt(stockField.value, 10) || 0,
          low_stock_threshold: parseInt(thresholdField.value, 10) || 0,
          package_size: packageSizeField.value.trim(),
        };
        console.log('[BoopBasket] calling boopbasket.add_mapping with', serviceData);
        await this._hass.callService('boopbasket', 'add_mapping', serviceData);
        console.log('[BoopBasket] boopbasket.add_mapping call returned');
        BoopBasketUI.showToast(this, 'Product added');
        this._barcodeField.value = '';
        this._debouncedRefresh();
      },
      'Add Product',
      'Cancel'
    );
  }

  _updateBulkActions(count) {
    const bulkDelete = this._bulkActions.querySelector('#bulk-delete');
    const countSpan = this._bulkActions.querySelector('span');
    if (bulkDelete) bulkDelete.disabled = count === 0;
    if (countSpan) countSpan.textContent = `${count} selected`;
  }

  async _showEditDialog(barcode, entry) {
    try {
      const freshData = await this._hass.callApi('GET', 'boopbasket/mappings');
      const freshEntry = freshData[barcode] || entry;

      BoopBasketUI.showDialog(
        this,
        'Edit Product',
        `
          <div style="display: flex; flex-direction: column; gap: 16px;">
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Barcode</label>
              <input class="boopbasket-input" id="barcodeField" value="${barcode}" readOnly style="font-family: monospace;" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Product Name *</label>
              <input class="boopbasket-input" id="nameField" value="${freshEntry.name || ''}" dialogInitialFocus />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Stock</label>
              <input class="boopbasket-input" id="stockField" type="number" min="0" step="1" value="${freshEntry.stock ?? freshEntry.quantity ?? 0}" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Low Stock Threshold</label>
              <input class="boopbasket-input" id="thresholdField" type="number" min="0" step="1" value="${freshEntry.low_stock_threshold ?? 0}" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Package Size</label>
              <input class="boopbasket-input" id="packageSizeField" value="${freshEntry.package_size || ''}" placeholder="Optional" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Brands</label>
              <input class="boopbasket-input" id="brandsField" value="${freshEntry.brands || ''}" placeholder="Optional" />
            </div>
          </div>
        `,
        async (dialog) => {
          const nameField = dialog.querySelector('#nameField');
          const stockField = dialog.querySelector('#stockField');
          const thresholdField = dialog.querySelector('#thresholdField');
          const packageSizeField = dialog.querySelector('#packageSizeField');
          const brandsField = dialog.querySelector('#brandsField');

          const name = nameField.value.trim();
          if (!name) return BoopBasketUI.showToast(this, 'Name required', true);

          await this._hass.callService('boopbasket', 'add_mapping', {
            code: barcode,
            product_name: name,
            brands: brandsField.value.trim(),
            stock: parseInt(stockField.value, 10) || 0,
            low_stock_threshold: parseInt(thresholdField.value, 10) || 0,
            package_size: packageSizeField.value.trim(),
          });
          BoopBasketUI.showToast(this, 'Product updated');
          this._debouncedRefresh();
        },
        'Save Changes',
        'Cancel'
      );
    } catch {
      BoopBasketUI.showDialog(
        this,
        'Edit Product',
        `
          <div style="display: flex; flex-direction: column; gap: 16px;">
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Barcode</label>
              <input class="boopbasket-input" id="barcodeField" value="${barcode}" readOnly style="font-family: monospace;" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Product Name *</label>
              <input class="boopbasket-input" id="nameField" value="${entry.name || ''}" dialogInitialFocus />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Stock</label>
              <input class="boopbasket-input" id="stockField" type="number" min="0" step="1" value="${entry.stock ?? entry.quantity ?? 0}" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Low Stock Threshold</label>
              <input class="boopbasket-input" id="thresholdField" type="number" min="0" step="1" value="${entry.low_stock_threshold ?? 0}" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Package Size</label>
              <input class="boopbasket-input" id="packageSizeField" value="${entry.package_size || ''}" placeholder="Optional" />
            </div>
            <div>
              <label style="display: block; font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 4px;">Brands</label>
              <input class="boopbasket-input" id="brandsField" value="${entry.brands || ''}" placeholder="Optional" />
            </div>
          </div>
        `,
        async (dialog) => {
          const nameField = dialog.querySelector('#nameField');
          const stockField = dialog.querySelector('#stockField');
          const thresholdField = dialog.querySelector('#thresholdField');
          const packageSizeField = dialog.querySelector('#packageSizeField');
          const brandsField = dialog.querySelector('#brandsField');

          const name = nameField.value.trim();
          if (!name) return BoopBasketUI.showToast(this, 'Name required', true);

          await this._hass.callService('boopbasket', 'add_mapping', {
            code: barcode,
            product_name: name,
            brands: brandsField.value.trim(),
            stock: parseInt(stockField.value, 10) || 0,
            low_stock_threshold: parseInt(thresholdField.value, 10) || 0,
            package_size: packageSizeField.value.trim(),
          });
          BoopBasketUI.showToast(this, 'Product updated');
          this._debouncedRefresh();
        },
        'Save Changes',
        'Cancel'
      );
    }
  }

  async _adjustStock(barcode, delta) {
    try {
      await this._hass.callService('boopbasket', 'adjust_stock', { barcode, delta });
      this._debouncedRefresh();
    } catch (e) {
      BoopBasketUI.showToast(this, `Error: ${e.message}`, true);
    }
  }

  _showDeleteDialog(barcode, entry) {
    BoopBasketUI.showDialog(
      this,
      'Delete Product',
      `<div style="padding: 24px; text-align: center;">
        <ha-icon icon="mdi:alert-circle" style="width: 64px; height: 64px; color: var(--error-color); margin-bottom: 16px;"></ha-icon>
        <div style="font-size: 18px; font-weight: 500;">Delete this product?</div>
        <div style="font-size: 14px; color: var(--secondary-text-color);">
          <strong>${entry.name || 'unknown'}</strong><br>
          <code style="font-family: monospace; font-size: 12px; background: var(--disabled-background-color); padding: 4px 8px; border-radius: 4px;">${barcode}</code>
        </div>
      </div>`,
      async () => {
        try {
          await this._hass.callService('boopbasket', 'remove_mapping', { barcode });
          BoopBasketUI.showToast(this, 'Product deleted');
          this._debouncedRefresh();
        } catch (e) {
          BoopBasketUI.showToast(this, `Error: ${e.message}`, true);
        }
      },
      'Delete',
      'Cancel',
      true
    );
  }

  async _deleteSelected() {
    const selected = Object.keys(this._selected).filter((k) => this._selected[k]);
    if (selected.length === 0) return;

    await BoopBasketUI.showDialog(
      this,
      'Delete Selected',
      `<div style="padding: 24px; text-align: center;">
        <ha-icon icon="mdi:alert-circle" style="width: 64px; height: 64px; color: var(--error-color); margin-bottom: 16px;"></ha-icon>
        <div style="font-size: 18px; font-weight: 500;">Delete ${selected.length} selected items?</div>
      </div>`,
      async () => {
        await Promise.all(
          selected.map((barcode) =>
            this._hass.callService('boopbasket', 'remove_mapping', { barcode })
          )
        );
        BoopBasketUI.showToast(this, `Deleted ${selected.length} items`);
        this._selected = {};
        this._debouncedRefresh();
      },
      'Delete All',
      'Cancel',
      true
    );
  }

  setConfig() { }
  getCardSize() {
    return 8;
  }
}

// Cache-bust query param for the lazily-loaded sub-scripts (see
// _loadModules) — bump this whenever boopbasket-camera/table/ui.js change.
BoopBasketCard.MODULE_VERSION = '1.0.0';

customElements.define('boopbasket-card', BoopBasketCard);
