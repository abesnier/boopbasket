window.BoopBasketCamera = {
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

    // Silently prefer the primary rear sensor over whatever
    // facingMode:'environment' would otherwise resolve to (often the
    // ultra-wide/virtual camera on multi-lens phones). Only works if
    // camera permission was already granted in a previous session, since
    // device labels are blank until then — falls back to the normal
    // facingMode flow silently if not.
    const defaultDeviceId = await this._pickDefaultCameraId();

    // Native <dialog>/<button> dialog chrome, shared with BoopBasketUI's
    // generic showDialog() — see boopbasket-ui.js for why this replaces
    // <ha-dialog>/<ha-button>.
    const { dialog, content, actions } = BoopBasketUI.createDialogShell('📷 Camera Scanner');
    content.style.cssText = 'text-align: center; padding: 1em;';
    content.innerHTML = `
      <div id="scannerVideoWrap" style="position: relative; width: 100%; max-width: 400px; margin: 0 auto; line-height: 0;">
        <video id="scannerVideo" autoplay playsinline muted
               style="width: 100%; border-radius: 8px; background: #000; display: block;"></video>
      </div>
      <div id="scannerStatus" style="margin-top: 1em; font-size: 0.9em; color: var(--secondary-text-color);">
        Click Start Camera to begin
      </div>
      <details id="scannerAdvanced" class="boopbasket-scanner-advanced" style="display: none;">
        <summary>Camera controls &amp; debug info</summary>
        <div id="scannerControls">
          <select id="scannerLensSelect" style="display: none; margin-top: 8px; max-width: 400px; width: 100%;"></select>
        </div>
        <div id="scannerDebug" style="margin-top: 0.5em; font-size: 0.75em; font-family: monospace; color: var(--secondary-text-color); text-align: left; white-space: pre-wrap; word-break: break-word;"></div>
      </details>
    `;

    const okBtn = BoopBasketUI.createButton('Start Camera', 'primary');
    okBtn.addEventListener('click', () => this._startCamera(card, dialog, defaultDeviceId));

    const closeBtn = BoopBasketUI.createButton('Close', 'secondary');
    closeBtn.addEventListener('click', () => dialog.close());

    actions.append(closeBtn, okBtn);

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

  // Guesses the primary rear-facing sensor's deviceId from its label
  // (e.g. Chromium's "camera2 0, facing back") so it can be requested
  // directly instead of leaving lens choice up to facingMode. Returns null
  // (silently — the caller just falls back to facingMode:'environment')
  // whenever labels aren't readable yet, there's only one camera, or none
  // of the labels parse as expected.
  async _pickDefaultCameraId() {
    if (!navigator.mediaDevices?.enumerateDevices) return null;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === 'videoinput');
      if (cameras.length < 2) return null;

      // Labels are blank until permission has been granted at least once —
      // without this check every device (front camera included) passes the
      // "not front-facing" filter below, so a blank-label front camera
      // could get guessed as the default rear sensor.
      if (cameras.every((cam) => !cam.label)) return null;

      const backCameras = cameras.filter((cam) => !/front/i.test(cam.label));
      if (!backCameras.length) return null;

      const indexed = backCameras
        .map((cam) => ({ cam, index: parseInt((cam.label.match(/camera2?\s*(\d+)/i) || [])[1], 10) }))
        .filter((c) => !Number.isNaN(c.index));

      if (indexed.length) {
        indexed.sort((a, b) => a.index - b.index);
        return indexed[0].cam.deviceId;
      }

      // No parseable index in any label (e.g. iOS/desktop naming): the
      // first non-front entry is the closest available guess at "main".
      return backCameras[0].deviceId;
    } catch (e) {
      return null;
    }
  },

  async _startCamera(card, dialog, deviceId) {
    const video = dialog.querySelector('#scannerVideo');
    const status = dialog.querySelector('#scannerStatus');
    // Captured once per dialog (not per call) since switching lenses calls
    // _startCamera again on the same dialog — recapturing here would risk
    // grabbing an already-overridden console.error as "original" and
    // permanently silencing it once the dialog closes.
    if (!('_originalConsoleError' in dialog)) dialog._originalConsoleError = console.error;
    const originalConsoleError = dialog._originalConsoleError;

    try {
      // NOTE: decodeFromVideoDevice()'s signature is strictly
      // (deviceId, videoElement, callback) — a 4th "options" argument is
      // silently ignored by ZXing, so facingMode/resolution/tryHarder/
      // delayBetweenScanAttempts previously passed here never took effect.
      // TRY_HARDER and the scan interval must go through the constructor,
      // and camera constraints must go through decodeFromConstraints().
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const codeReader = new ZXing.BrowserMultiFormatReader(hints, 150);
      dialog._codeReader = codeReader;

      // Silence ZXing noise
      console.error = () => {};

      status.textContent = 'Starting camera...';

      const constraints = {
        video: {
          // A specific deviceId (picked from the lens selector) always wins;
          // otherwise fall back to whatever the platform decides
          // "environment" means, which on multi-lens phones is often the
          // ultra-wide/virtual camera rather than the main autofocus sensor.
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
          // Higher resolution gives the decoder (and the autofocus
          // algorithm, which uses contrast/sharpness of the same frame)
          // more detail to work with than the previous 640x480 default.
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };

      codeReader.decodeFromConstraints(constraints, video, (result) => {
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
          BoopBasketUI.showToast(card, `📷 Scanned: ${result.text}`);
        }
      });

      status.textContent = '📷 Point barcode at camera';

      // Tap-to-focus + zoom/lens bias: only wire these up once the stream is
      // actually attached to the video element (srcObject is set
      // asynchronously by ZXing).
      video.addEventListener(
        'loadedmetadata',
        () => {
          const track = video.srcObject && video.srcObject.getVideoTracks()[0];
          if (track) {
            // Hidden until now (see openScanner) so the collapsed header
            // itself isn't visible before there's anything real behind it
            // to control or debug.
            dialog.querySelector('#scannerAdvanced').style.display = '';
            this._renderDebugInfo(dialog, track);
            this._optimizeFocus(dialog, track);
            this._attachTapToFocus(dialog, video, track);
            this._attachZoomControl(dialog, track);
            this._populateLensSelector(card, dialog, track);
          }
        },
        { once: true }
      );

      // Bind once per dialog: _startCamera runs again on every lens switch,
      // and stacking one 'close' listener per switch meant later (stale)
      // listeners would fire after earlier ones and clobber the console.error
      // restore. Reading dialog._codeReader at close time (rather than
      // closing over this call's `codeReader`) means it always resets
      // whichever reader is actually current.
      if (!dialog._closeCleanupBound) {
        dialog._closeCleanupBound = true;
        dialog.addEventListener(
          'close',
          () => {
            if (dialog._codeReader) dialog._codeReader.reset();
            console.error = dialog._originalConsoleError;
          },
          { once: true }
        );
      }
    } catch (e) {
      console.error = originalConsoleError;
      status.textContent = 'Camera failed';
      BoopBasketUI.showToast(card, 'Camera error: ' + e.message, true);
    }
  },

  // Lists every camera the platform exposes (labels are only readable once
  // permission has been granted, i.e. after the stream above already
  // started) so the user can manually pick the physical lens that actually
  // autofocuses — `facingMode: 'environment'` alone can't express that on
  // multi-lens phones, since the OS/browser picks a default (often the
  // ultra-wide or a "virtual" combined camera) with no way to know in
  // advance which of several "back" cameras that resolves to.
  async _populateLensSelector(card, dialog, track) {
    const select = dialog.querySelector('#scannerLensSelect');
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;

    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      return;
    }

    const cameras = devices.filter((d) => d.kind === 'videoinput');
    if (cameras.length < 2) return; // nothing to switch between

    const currentId = track.getSettings ? track.getSettings().deviceId : null;

    select.innerHTML = '';
    cameras.forEach((cam, i) => {
      const option = document.createElement('option');
      option.value = cam.deviceId;
      option.textContent = cam.label || `Camera ${i + 1}`;
      if (cam.deviceId === currentId) option.selected = true;
      select.appendChild(option);
    });
    select.style.display = 'block';

    // Rebind fresh each time so switching lenses repeatedly doesn't stack
    // duplicate 'change' handlers on the same <select> element.
    select.onchange = () => this._switchCamera(card, dialog, select.value);
  },

  // Tears down the current stream/decoder and any lens-specific controls,
  // then restarts with the explicitly chosen deviceId.
  async _switchCamera(card, dialog, deviceId) {
    const video = dialog.querySelector('#scannerVideo');
    if (dialog._codeReader) dialog._codeReader.reset();
    if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());

    dialog._debugLog = [];
    dialog
      .querySelectorAll('.boopbasket-zoom-slider, .boopbasket-manual-focus-label')
      .forEach((el) => el.remove());

    this._startCamera(card, dialog, deviceId);
  },

  // Shows exactly what the browser/camera HAL reports for this track, so
  // "should work but doesn't" cases can be diagnosed: on Android, focusMode
  // and zoom are part of the (non-standard, spec-in-flux) Image Capture
  // API extensions, and support for them is inconsistent across
  // Chrome versions, chipsets, and camera HALs — many devices report an
  // empty/missing focusMode or zoom capability even though the phone's own
  // camera app can autofocus/zoom just fine, because that's handled by
  // vendor-specific camera app code with no web-exposed equivalent.
  _renderDebugInfo(dialog, track) {
    const debugEl = dialog.querySelector('#scannerDebug');
    if (!debugEl) return;

    let capabilities = {};
    let settings = {};
    let capError = null;
    try {
      capabilities = track.getCapabilities ? track.getCapabilities() : null;
    } catch (e) {
      capError = e.message;
    }
    try {
      settings = track.getSettings ? track.getSettings() : {};
    } catch (e) {
      // ignore
    }

    if (!track.getCapabilities) {
      debugEl.textContent = 'getCapabilities() not supported by this browser at all.';
      return;
    }
    if (capError) {
      debugEl.textContent = `getCapabilities() threw: ${capError}`;
      return;
    }
    if (!capabilities || Object.keys(capabilities).length === 0) {
      debugEl.textContent = 'getCapabilities() returned empty — this browser/HAL exposes no extended controls for this camera.';
      return;
    }

    const lines = [];
    lines.push(`focusMode: ${JSON.stringify(capabilities.focusMode) ?? 'not reported'}`);
    lines.push(
      `pointsOfInterest: ${'pointsOfInterest' in capabilities ? 'reported' : 'not reported'}`
    );
    lines.push(`focusDistance: ${JSON.stringify(capabilities.focusDistance) ?? 'not reported'}`);
    lines.push(`zoom: ${JSON.stringify(capabilities.zoom) ?? 'not reported'}`);
    lines.push(`current settings.zoom: ${settings.zoom ?? 'n/a'}`);
    lines.push(`current settings.focusMode: ${settings.focusMode ?? 'n/a'}`);
    lines.push(`current settings.focusDistance: ${settings.focusDistance ?? 'n/a'}`);
    lines.push(`facingMode: ${settings.facingMode ?? 'n/a'}`);
    lines.push(`deviceId: ${(settings.deviceId || '').slice(0, 12) || 'n/a'}`);

    if (dialog._debugLog && dialog._debugLog.length) {
      lines.push('---');
      lines.push(...dialog._debugLog);
    }

    debugEl.textContent = lines.join('\n');
  },

  // console.warn is invisible when testing through the Companion App on a
  // phone, so applyConstraints() outcomes get appended to the on-screen
  // debug panel instead, and the panel is refreshed to show the resulting
  // settings (proof the constraint actually took effect, not just resolved).
  _logConstraintResult(dialog, track, label, promise) {
    promise.then(
      () => {
        dialog._debugLog = (dialog._debugLog || []).slice(-4);
        dialog._debugLog.push(`${label}: applied ok`);
        this._renderDebugInfo(dialog, track);
      },
      (e) => {
        dialog._debugLog = (dialog._debugLog || []).slice(-4);
        dialog._debugLog.push(`${label}: rejected — ${e.message || e}`);
        this._renderDebugInfo(dialog, track);
      }
    );
  },

  // Proactively requests continuous autofocus (rather than waiting for the
  // user to tap), and biases it toward near/macro distances since a
  // hand-held barcode is typically much closer to the lens than whatever
  // the camera's default focus distance assumes. Falls back to repeated
  // single-shot focus pulses at the center point on hardware that doesn't
  // expose 'continuous' as a focusMode option.
  _optimizeFocus(dialog, track) {
    let capabilities = {};
    try {
      capabilities = track.getCapabilities ? track.getCapabilities() : {};
    } catch (e) {
      capabilities = {};
    }

    const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
    const advanced = [];
    const hasFocusDistance =
      typeof capabilities.focusDistance === 'object' && capabilities.focusDistance != null;
    const nearDistance = hasFocusDistance ? capabilities.focusDistance.min ?? 0 : null;

    if (focusModes.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
      // Bias toward the near end of the supported focus distance range —
      // most phone cameras default closer to infinity, which is wrong for
      // a barcode held a few inches from the lens.
      if (hasFocusDistance) advanced.push({ focusDistance: nearDistance });
    } else if (focusModes.includes('manual') && hasFocusDistance) {
      // 'manual' means the HAL exposes zero autofocus to the browser — the
      // only lever is setting an absolute lens distance ourselves, so there
      // is no continuous/single-shot to request here at all.
      advanced.push({ focusMode: 'manual', focusDistance: nearDistance });
    }

    if (advanced.length) {
      this._logConstraintResult(dialog, track, 'initial focus', track.applyConstraints({ advanced }));
    }

    if (focusModes.includes('manual') && hasFocusDistance) {
      this._attachFocusDistanceControl(dialog, track, capabilities.focusDistance, nearDistance);
    }

    if (!focusModes.includes('continuous') && focusModes.includes('single-shot')) {
      const refocus = () => {
        track
          .applyConstraints({
            advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x: 0.5, y: 0.5 }] }],
          })
          .catch(() => {});
      };
      refocus();
      // Re-trigger periodically: single-shot focus locks once and won't
      // re-adjust as the user's hand (and the barcode) moves closer/farther.
      const interval = setInterval(refocus, 2000);
      track.addEventListener('ended', () => clearInterval(interval), { once: true });
    }
  },

  // 'manual' focusMode devices have no autofocus at all — the lens only
  // moves when the browser tells it an exact distance to move to, so we
  // give the user a slider to drive it themselves, same idea as the zoom
  // slider fallback below.
  _attachFocusDistanceControl(dialog, track, focusDistance, initialValue) {
    const { min = 0, max = 1, step = 0.01 } = focusDistance;
    if (max <= min) return; // device reports no usable range

    const controls = dialog.querySelector('#scannerControls');
    const label = document.createElement('div');
    label.textContent = 'Manual focus';
    label.className = 'boopbasket-manual-focus-label';
    label.style.cssText =
      'font-size: 0.75em; color: var(--secondary-text-color); margin: 8px auto 2px; max-width: 400px;';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step || 0.01;
    slider.value = initialValue ?? min;
    slider.className = 'boopbasket-zoom-slider';
    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);
      // Some Chromium/WebView builds only honor non-standard constraints
      // when set top-level, others only inside 'advanced' — set both so
      // whichever path this build actually reads picks it up.
      this._logConstraintResult(
        dialog,
        track,
        'manual focus',
        track.applyConstraints({
          focusMode: 'manual',
          focusDistance: value,
          advanced: [{ focusMode: 'manual', focusDistance: value }],
        })
      );
    });

    controls.appendChild(label);
    controls.appendChild(slider);
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

    // Rebind via assignment (not addEventListener) so switching lenses
    // repeatedly doesn't stack duplicate click handlers on this persistent
    // element — each stacked handler would otherwise keep firing
    // applyConstraints() against its own stale/stopped track on every tap.
    wrap.onclick = (event) => {
      const rect = wrap.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;

      this._showFocusRing(wrap, event.clientX - rect.left, event.clientY - rect.top);

      this._logConstraintResult(
        dialog,
        track,
        'tap focus',
        track.applyConstraints({
          advanced: [
            {
              focusMode: capabilities.focusMode.includes('single-shot')
                ? 'single-shot'
                : 'manual',
              pointsOfInterest: [{ x, y }],
            },
          ],
        })
      );
    };
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
      this._logConstraintResult(dialog, track, 'zoom', track.applyConstraints({ advanced: [{ zoom: value }] }));
    };

    applyZoom(initialZoom);

    // Manual slider fallback, since auto lens-switching can't be
    // guaranteed on every device.
    const controls = dialog.querySelector('#scannerControls');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step || 0.1;
    slider.value = initialZoom;
    slider.className = 'boopbasket-zoom-slider';
    slider.addEventListener('input', () => applyZoom(parseFloat(slider.value)));
    controls.appendChild(slider);
  },

  _showFocusRing(wrap, px, py) {
    const ring = document.createElement('div');
    ring.className = 'boopbasket-focus-ring';
    ring.style.left = `${px}px`;
    ring.style.top = `${py}px`;
    wrap.appendChild(ring);
    ring.addEventListener('animationend', () => ring.remove(), { once: true });
  },

  // Camera-only styling (dialog chrome + buttons now live in
  // BoopBasketUI._ensureDialogStyles(), shared with the rest of the card).
  _ensureStyles() {
    if (document.getElementById('boopbasket-camera-styles')) return;

    const style = document.createElement('style');
    style.id = 'boopbasket-camera-styles';
    style.textContent = `
      .boopbasket-focus-ring {
        position: absolute;
        width: 56px;
        height: 56px;
        margin-left: -28px;
        margin-top: -28px;
        border: 2px solid #fff;
        border-radius: 50%;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
        pointer-events: none;
        animation: boopbasket-focus-pulse 0.6s ease-out forwards;
      }
      @keyframes boopbasket-focus-pulse {
        0% { transform: scale(1.4); opacity: 1; }
        100% { transform: scale(1); opacity: 0; }
      }
      .boopbasket-zoom-slider {
        display: block;
        width: 100%;
        max-width: 400px;
        margin: 8px auto 0;
        accent-color: var(--primary-color, #03a9f4);
      }
      .boopbasket-scanner-advanced {
        max-width: 400px;
        margin: 0.75em auto 0;
        text-align: left;
      }
      .boopbasket-scanner-advanced summary {
        cursor: pointer;
        font-size: 0.85em;
        color: var(--secondary-text-color);
        text-align: center;
        user-select: none;
      }
      .boopbasket-scanner-advanced summary:hover {
        color: var(--primary-text-color);
      }
      .boopbasket-scanner-advanced[open] summary {
        margin-bottom: 4px;
      }
    `;
    document.head.appendChild(style);
  },
};
