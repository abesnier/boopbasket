window.BeepBasketCamera = {
  async openScanner(card) {
    // 1. Load ZXing FIRST
    if (!window.ZXing) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/@zxing/library@latest/umd/index.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    this._ensureStyles();

    // 2. Native <dialog> instead of <ha-dialog>.
    // ha-dialog/ha-button rely on custom-element upgrade + internal slot
    // rendering (Lit/mwc-dialog) that can silently fail to mount action
    // buttons when the dialog is assembled imperatively like this. A plain
    // <dialog> with real <button> elements has no such lifecycle to fight,
    // and showModal() gives us the same focus-trapping/backdrop behavior.
    const dialog = document.createElement('dialog');
    dialog.className = 'beepbasket-scanner-dialog';

    const heading = document.createElement('div');
    heading.className = 'beepbasket-scanner-heading';
    heading.textContent = '📷 Camera Scanner';

    const content = document.createElement('div');
    content.style.cssText = 'text-align: center; padding: 1em;';
    content.innerHTML = `
      <div id="scannerVideoWrap" style="position: relative; width: 100%; max-width: 400px; margin: 0 auto; line-height: 0;">
        <video id="scannerVideo" autoplay playsinline muted
               style="width: 100%; border-radius: 8px; background: #000; display: block;"></video>
      </div>
      <div id="scannerStatus" style="margin-top: 1em; font-size: 0.9em; color: var(--secondary-text-color);">
        Click Start Camera to begin
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'beepbasket-scanner-actions';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'beepbasket-btn beepbasket-btn-primary';
    okBtn.textContent = 'Start Camera';
    okBtn.addEventListener('click', () => this._startCamera(card, dialog));

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'beepbasket-btn beepbasket-btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => dialog.close());

    actions.append(closeBtn, okBtn);
    dialog.append(heading, content, actions);
    document.body.appendChild(dialog);

    // Clean up (stop camera + remove from DOM) whenever the dialog closes,
    // whether via the Close button, Esc key, or backdrop click.
    dialog.addEventListener(
      'close',
      () => {
        const video = dialog.querySelector('#scannerVideo');
        if (video && video.srcObject) {
          video.srcObject.getTracks().forEach((track) => track.stop());
        }
        dialog.remove();
      },
      { once: true }
    );

    dialog.showModal();
  },

  async _startCamera(card, dialog) {
    const video = dialog.querySelector('#scannerVideo');
    const status = dialog.querySelector('#scannerStatus');
    const originalConsoleError = console.error;

    try {
      const codeReader = new ZXing.BrowserMultiFormatReader();

      // Silence ZXing noise
      console.error = () => {};

      status.textContent = 'Starting camera...';

      codeReader.decodeFromVideoDevice(
        null,
        video,
        (result) => {
          console.error = originalConsoleError;

          if (result) {
            console.log('✅ SCANNED:', result.text);
            status.textContent = `✅ Found: ${result.text}`;
            codeReader.reset();
            card._barcodeField.value = result.text;
            setTimeout(() => {
              card._addQuick();
              dialog.close();
            }, 500);
            BeepBasketUI.showToast(card, `📷 Scanned: ${result.text}`);
          }
        },
        {
          delayBetweenScanAttempts: 1000,
          tryHarder: true,
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
        }
      );

      status.textContent = '📷 Point barcode at camera';

      // Tap-to-focus + zoom/lens bias: only wire these up once the stream is
      // actually attached to the video element (srcObject is set
      // asynchronously by ZXing).
      video.addEventListener(
        'loadedmetadata',
        () => {
          const track = video.srcObject && video.srcObject.getVideoTracks()[0];
          if (track) {
            this._attachTapToFocus(dialog, video, track);
            this._attachZoomControl(dialog, track);
          }
        },
        { once: true }
      );

      dialog.addEventListener(
        'close',
        () => {
          codeReader.reset();
          console.error = originalConsoleError;
        },
        { once: true }
      );
    } catch (e) {
      console.error = originalConsoleError;
      status.textContent = 'Camera failed';
      BeepBasketUI.showToast(card, 'Camera error', true);
    }
  },

  // Wires up tap-to-focus on the video preview. This uses the non-standard
  // `pointsOfInterest` / `focusMode: 'single-shot'` MediaTrackConstraints,
  // which is currently only implemented by Chrome on Android with hardware
  // that exposes manual focus control. It has no effect (and no visible
  // error) on iOS Safari or desktop browsers, since neither the capability
  // nor applyConstraints() support for it exists there — the tap simply
  // does nothing on those platforms.
  _attachTapToFocus(dialog, video, track) {
    const wrap = dialog.querySelector('#scannerVideoWrap');

    let capabilities = {};
    try {
      capabilities = track.getCapabilities ? track.getCapabilities() : {};
    } catch (e) {
      capabilities = {};
    }

    const supportsFocus =
      Array.isArray(capabilities.focusMode) &&
      (capabilities.focusMode.includes('single-shot') ||
        capabilities.focusMode.includes('manual')) &&
      'pointsOfInterest' in capabilities;

    if (!supportsFocus) return; // silently no-op on unsupported platforms

    wrap.style.cursor = 'crosshair';

    wrap.addEventListener('click', async (event) => {
      const rect = wrap.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      this._showFocusRing(wrap, event.clientX - rect.left, event.clientY - rect.top);

      try {
        await track.applyConstraints({
          advanced: [
            {
              focusMode: capabilities.focusMode.includes('single-shot')
                ? 'single-shot'
                : 'manual',
              pointsOfInterest: [{ x, y }],
            },
          ],
        });
      } catch (e) {
        // Some devices report the capability but reject the constraint at
        // runtime; fail quietly rather than interrupting the scan.
        console.warn('BeepBasket: focus constraint rejected', e);
      }
    });
  },

  // Nudges the camera off an ultra-wide lens (where the platform exposes a
  // virtual multi-camera that switches lenses based on zoom, i.e. iOS
  // Safari and some newer Android/Chrome combos) and gives the user a
  // manual slider as a fallback everywhere else, since there's no
  // standardized way to query "which physical lens is this" from the web
  // platform — `zoom` is the only lever available.
  _attachZoomControl(dialog, track) {
    let capabilities = {};
    try {
      capabilities = track.getCapabilities ? track.getCapabilities() : {};
    } catch (e) {
      capabilities = {};
    }

    if (typeof capabilities.zoom !== 'object' || capabilities.zoom == null) return;

    const { min = 1, max = 1, step = 0.1 } = capabilities.zoom;
    if (max <= min) return; // no usable zoom range on this device

    // Bias initial zoom to 1x or slightly above: on platforms with a
    // virtual multi-camera this steers the OS away from the ultra-wide
    // lens; elsewhere it's a harmless digital crop that fills the frame
    // with the barcode better.
    const initialZoom = Math.min(Math.max(1, min), max);

    const applyZoom = async (value) => {
      try {
        await track.applyConstraints({ advanced: [{ zoom: value }] });
      } catch (e) {
        console.warn('BeepBasket: zoom constraint rejected', e);
      }
    };

    applyZoom(initialZoom);

    // Manual slider fallback, since auto lens-switching can't be
    // guaranteed on every device.
    const wrap = dialog.querySelector('#scannerVideoWrap');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step || 0.1;
    slider.value = initialZoom;
    slider.className = 'beepbasket-zoom-slider';
    slider.addEventListener('input', () => applyZoom(parseFloat(slider.value)));
    wrap.insertAdjacentElement('afterend', slider);
  },

  _showFocusRing(wrap, px, py) {
    const ring = document.createElement('div');
    ring.className = 'beepbasket-focus-ring';
    ring.style.left = `${px}px`;
    ring.style.top = `${py}px`;
    wrap.appendChild(ring);
    ring.addEventListener('animationend', () => ring.remove(), { once: true });
  },

  _ensureStyles() {
    if (document.getElementById('beepbasket-scanner-styles')) return;

    const style = document.createElement('style');
    style.id = 'beepbasket-scanner-styles';
    style.textContent = `
      .beepbasket-scanner-dialog {
        border: none;
        border-radius: 12px;
        padding: 16px;
        max-width: 420px;
        width: 90vw;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        box-shadow: var(--ha-dialog-box-shadow, 0 8px 24px rgba(0, 0, 0, 0.3));
      }
      .beepbasket-scanner-dialog::backdrop {
        background: rgba(0, 0, 0, 0.5);
      }
      .beepbasket-scanner-heading {
        font-size: 1.25em;
        font-weight: 500;
        margin-bottom: 8px;
        text-align: center;
      }
      .beepbasket-scanner-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
      .beepbasket-btn {
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 0.9em;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
      }
      .beepbasket-btn-primary {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .beepbasket-btn-secondary {
        background: transparent;
        color: var(--primary-color, #03a9f4);
      }
      .beepbasket-focus-ring {
        position: absolute;
        width: 56px;
        height: 56px;
        margin-left: -28px;
        margin-top: -28px;
        border: 2px solid #fff;
        border-radius: 50%;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
        pointer-events: none;
        animation: beepbasket-focus-pulse 0.6s ease-out forwards;
      }
      @keyframes beepbasket-focus-pulse {
        0% { transform: scale(1.4); opacity: 1; }
        100% { transform: scale(1); opacity: 0; }
      }
      .beepbasket-zoom-slider {
        display: block;
        width: 100%;
        max-width: 400px;
        margin: 8px auto 0;
        accent-color: var(--primary-color, #03a9f4);
      }
    `;
    document.head.appendChild(style);
  },
};
