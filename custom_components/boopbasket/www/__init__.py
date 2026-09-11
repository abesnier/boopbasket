"""BoopBasket Lovelace card registration.

Registers this directory (custom_components/boopbasket/www/) as a static
path and the main card script as a frontend resource, so users never have
to add a Lovelace resource by hand. Structured after the pattern used by
https://github.com/asantaga/wiserHomeAssistantPlatform/tree/master/custom_components/wiser/frontend
— a Lovelace storage-mode module resource (with proper version tracking, so
an updated CARD_VERSION here actually busts the frontend's own cache) is
used when available, since it's more robust than the older
add_extra_js_url() script injection. That older mechanism is kept only as a
fallback for YAML-mode dashboards, where resources can't be managed
dynamically.
"""
import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import MODE_STORAGE
from homeassistant.const import MAJOR_VERSION, MINOR_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

_LOGGER = logging.getLogger(__name__)

URL_BASE = "/boopbasket_static"
CARD_FILENAME = "boopbasket-card.js"
# Bumped by hand in lockstep with BoopBasketCard.MODULE_VERSION in
# boopbasket-card.js whenever any www/*.js file changes — this is what
# actually busts the frontend's cache of the main card script.
CARD_VERSION = "1.0.5"


class BoopBasketFrontendRegistration:
    """Register the BoopBasket card's static path and frontend resource."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise."""
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")
        if self.lovelace is not None:
            # Attribute renamed from `mode` to `resource_mode` in HA 2026.2.
            if (MAJOR_VERSION, MINOR_VERSION) >= (2026, 2):
                self.resource_mode = self.lovelace.resource_mode
            else:
                self.resource_mode = self.lovelace.mode
        else:
            self.resource_mode = None

    async def async_register(self) -> None:
        """Register the static path and the card resource."""
        await self._async_register_path()

        if self.lovelace is not None and self.resource_mode == MODE_STORAGE:
            await self._async_wait_for_lovelace_resources()
        else:
            # YAML-mode dashboards (or lovelace not loaded yet) can't have
            # resources managed dynamically here; fall back to the
            # unconditional, idempotent script injection instead, which
            # works regardless of dashboard mode.
            add_extra_js_url(
                self.hass, f"{URL_BASE}/{CARD_FILENAME}?v={CARD_VERSION}", es5=False
            )

    async def _async_register_path(self) -> None:
        """Register this directory as a static path, once per HA run."""
        try:
            await self.hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, str(Path(__file__).parent), False)]
            )
            _LOGGER.debug("Registered resource path from %s", Path(__file__).parent)
        except RuntimeError:
            # Already registered — e.g. a config entry reload in the same
            # running process. There's no unregister API for a static path,
            # so this is expected and harmless.
            _LOGGER.debug("Resource path already registered")

    async def _async_wait_for_lovelace_resources(self) -> None:
        """Wait for Lovelace resources to finish loading before registering."""

        async def _check_loaded(_now):
            if self.lovelace.resources.loaded:
                await self._async_register_module()
            else:
                _LOGGER.debug(
                    "Lovelace resources not loaded yet, retrying in 5s"
                )
                async_call_later(self.hass, 5, _check_loaded)

        await _check_loaded(None)

    async def _async_register_module(self) -> None:
        """Add or update the card's Lovelace module resource."""
        url = f"{URL_BASE}/{CARD_FILENAME}"

        existing = [
            resource
            for resource in self.lovelace.resources.async_items()
            if resource["url"].split("?")[0] == url
        ]

        if not existing:
            _LOGGER.debug("Registering %s as version %s", CARD_FILENAME, CARD_VERSION)
            await self.lovelace.resources.async_create_item(
                {"res_type": "module", "url": f"{url}?v={CARD_VERSION}"}
            )
            return

        resource = existing[0]
        current_version = (
            resource["url"].split("?v=")[-1] if "?v=" in resource["url"] else None
        )
        if current_version != CARD_VERSION:
            _LOGGER.debug("Updating %s to version %s", CARD_FILENAME, CARD_VERSION)
            await self.lovelace.resources.async_update_item(
                resource["id"],
                {"res_type": "module", "url": f"{url}?v={CARD_VERSION}"},
            )
        else:
            _LOGGER.debug(
                "%s already registered as version %s", CARD_FILENAME, CARD_VERSION
            )

    async def async_unregister(self) -> None:
        """Remove the card's Lovelace module resource (storage mode only)."""
        if self.lovelace is None or self.resource_mode != MODE_STORAGE:
            return
        url = f"{URL_BASE}/{CARD_FILENAME}"
        for resource in list(self.lovelace.resources.async_items()):
            if resource["url"].split("?")[0] == url:
                await self.lovelace.resources.async_delete_item(resource["id"])
