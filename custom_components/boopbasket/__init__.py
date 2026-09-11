import logging
import aiohttp
import asyncio
import json
import aiofiles
from datetime import datetime
from typing import Dict, Any, Optional
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import callback
from homeassistant.helpers.event import async_track_state_change_event

from .www import BoopBasketFrontendRegistration

DOMAIN = "boopbasket"
TODO_DOMAIN = "todo"

_LOGGER = logging.getLogger(__name__)

class BarcodeCache:
    """Structured cache aligned with OpenFoodFacts schema."""

    def __init__(self, cache_path: str, hass):
        self._cache_path = cache_path
        self.hass = hass
        self._cache: Dict[str, Dict[str, Any]] = {}
        # Guards every read-modify-write below: a rapid table +/- stepper
        # click, a hardware scan event, and another scan racing it can all
        # touch the same barcode's entry at once without this.
        self._lock = asyncio.Lock()

    async def load(self):
        """Load structured cache from custom_components folder."""
        try:
            async with aiofiles.open(self._cache_path, 'r', encoding='utf-8') as f:
                content = await f.read()
                self._cache = json.loads(content) if content.strip() else {}
            _LOGGER.info("📂 Loaded %d structured cache entries", len(self._cache))
        except FileNotFoundError:
            _LOGGER.info("📂 New cache file created")
            self._cache = {}
        except json.JSONDecodeError as e:
            _LOGGER.error("❌ Cache JSON corrupt: %s", e)
            self._cache = {}

    async def _save(self):
        """Persist structured cache."""
        async with aiofiles.open(self._cache_path, 'w', encoding='utf-8') as f:
            await f.write(json.dumps(self._cache, indent=2, ensure_ascii=False))

    async def get(self, barcode: str) -> Optional[Dict[str, Any]]:
        """Get full structured entry."""
        return self._cache.get(barcode)

    async def get_display_name(self, barcode: str) -> str:
        """For shopping list - safe fallback."""
        entry = self._cache.get(barcode)
        if entry and entry.get("status") == "complete":
            return entry.get("name", barcode)
        return barcode

    async def set_product(self, barcode: str, product_data: Dict[str, Any]):
        """Set complete product (API or manual)."""
        async with self._lock:
            product_data["status"] = "complete"
            product_data["scanned_count"] = product_data.get("scanned_count", 0) + 1
            product_data["last_updated"] = datetime.now().isoformat()
            self._cache[barcode] = product_data
            await self._save()
        self.hass.bus.async_fire("barcode_cache_updated")
        _LOGGER.info("💾 Cached product: %s → %s", barcode, product_data.get("name"))

    async def set_stock(self, barcode: str, stock: int):
        """Set how many units of this product are currently on hand,
        without touching the rest of the cached data."""
        async with self._lock:
            entry = self._cache.get(barcode)
            if entry is None:
                return
            entry["stock"] = max(0, stock)
            entry.pop("quantity", None)
            await self._save()
        self.hass.bus.async_fire("barcode_cache_updated")

    async def adjust_stock(self, barcode: str, delta: int) -> Optional[int]:
        """Adjust on-hand stock by delta (may be negative), clamped at a
        minimum of 0. Returns the new stock value, or None if the barcode
        isn't mapped yet."""
        async with self._lock:
            entry = self._cache.get(barcode)
            if entry is None:
                return None
            current = entry.get("stock", entry.get("quantity", 0))
            new_stock = max(0, current + delta)
            entry["stock"] = new_stock
            entry.pop("quantity", None)
            await self._save()
        self.hass.bus.async_fire("barcode_cache_updated")
        return new_stock

    async def set_unknown(self, barcode: str):
        """Track unknown barcode scans WITH name=barcode."""
        async with self._lock:
            if barcode not in self._cache:
                self._cache[barcode] = {
                    "status": "unknown",
                    "name": barcode,
                    "scanned_count": 0,
                    "first_seen": datetime.now().isoformat()
                }

            entry = self._cache[barcode]
            entry["scanned_count"] += 1
            if entry["scanned_count"] >= 3:
                entry["ready_to_contribute"] = True

            await self._save()
        self.hass.bus.async_fire("barcode_cache_updated")
        _LOGGER.info("❓ Unknown #%d: %s (%s)", entry["scanned_count"], barcode, entry["name"])

    async def remove(self, barcode: str):
        """Remove entry."""
        async with self._lock:
            if barcode not in self._cache:
                return
            del self._cache[barcode]
            await self._save()
        self.hass.bus.async_fire("barcode_cache_updated")
        _LOGGER.info("🗑️ Removed: %s", barcode)

    def get_cache_for_api(self) -> Dict[str, Dict[str, Any]]:
        """Return full structured cache for REST API."""
        return self._cache

class BarcodeListView(HomeAssistantView):
    """REST endpoint for barcode cache (GET mappings)."""
    url = "/api/boopbasket/mappings"
    name = "api:boopbasket:mappings"
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def get(self, request):
        cache = self.hass.data[DOMAIN]["cache"]
        return self.json(cache.get_cache_for_api())

class BarcodeCacheAddView(HomeAssistantView):
    """REST endpoint to add cache entry."""
    url = "/api/boopbasket/cache/add"
    name = "api:boopbasket:cache:add"
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def post(self, request):
        data = await request.json()
        barcode = data.get("barcode")
        product_data = data.get("product_data", {})
        if barcode and product_data:
            cache = self.hass.data[DOMAIN]["cache"]
            await cache.set_product(barcode.strip(), product_data)
            return self.json({"success": True})
        return self.json({"error": "Missing barcode or product_data"}, 400)

class BarcodeCacheRemoveView(HomeAssistantView):
    """REST endpoint to remove cache entry."""
    url = "/api/boopbasket/cache/remove"
    name = "api:boopbasket:cache:remove"
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def post(self, request):
        data = await request.json()
        barcode = data.get("barcode")
        if barcode:
            cache = self.hass.data[DOMAIN]["cache"]
            await cache.remove(barcode.strip())
            return self.json({"success": True})
        return self.json({"error": "Missing barcode"}, 400)

class BarcodeLookupView(HomeAssistantView):
    """Lookup single barcode."""
    url = "/api/boopbasket/lookup/{barcode}"      # ← FIRST
    name = "api:boopbasket:lookup"               # ← SECOND
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def get(self, request, barcode: str):
        result = await lookup_product(self.hass, barcode)
        if result:
            return self.json(result)
        return self.json({"error": "Product not found"})

class BoopBasketConfigView(HomeAssistantView):
    """Exposes the todo entity chosen in config flow, so the card doesn't
    have to hardcode a specific list (it used to hardcode todo.shopping_list,
    which broke as soon as a different list was linked at setup)."""
    url = "/api/boopbasket/config"
    name = "api:boopbasket:config"
    requires_auth = True

    def __init__(self, hass):
        self.hass = hass

    async def get(self, request):
        return self.json({"todo_entity": self.hass.data[DOMAIN].get("shopping_list_entity")})

def is_valid_barcode(code: str) -> bool:
    """Filter barcodes vs QR codes"""
    if len(code) < 8:
        return False
    if code.isdigit() and 8 <= len(code) <= 14:
        return True
    if len(code) > 20 or '.' in code or '/' in code or '=' in code:
        return False
    return True

async def get_cache_path(hass: HomeAssistant) -> str:
    """HA-standard: custom_components/boopbasket/barcode_cache.json"""
    return hass.config.path(f"custom_components/{DOMAIN}/barcode_cache.json")

async def lookup_product(hass: HomeAssistant, barcode: str) -> Optional[Dict[str, Any]]:
    """Robust OpenFoodFacts lookup returning structured data."""
    url = f"https://world.openfoodfacts.org/api/v3.6/product/{barcode}.json"
    timeout = aiohttp.ClientTimeout(total=10)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                # v3.6 responds 404 (not 200-with-status:0 like the legacy
                # v0 API) for a barcode it doesn't know, so this already
                # covers "not found" — the status field check below is just
                # defense in depth for any other non-success response shape.
                if resp.status != 200:
                    _LOGGER.debug("Lookup: HTTP %s for %s", resp.status, barcode)
                    return None

                data = await resp.json()

                if data.get("status") != "success":
                    _LOGGER.debug("Product not found: %s", barcode)
                    return None

                product = data.get("product", {})
                name = (product.get("product_name") or
                       product.get("generic_name") or
                       product.get("brands") or
                       product.get("categories", "").split(",")[0].strip()).strip()

                if name:
                    _LOGGER.debug("Found: %s → %s", barcode, name)
                    return {
                        "name": name,
                        "brands": product.get("brands", ""),
                        "categories": product.get("categories", ""),
                        "package_size": product.get("quantity", ""),
                        "source": "openfoodfacts"
                    }

                _LOGGER.debug("Valid product but no name data: %s", barcode)
                return None

    except Exception as err:
        _LOGGER.warning("API lookup error for %s: %s", barcode, err)
        return None

async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Options Flow changes take effect via a full reload, same as any
    other config entry change."""
    await hass.config_entries.async_reload(entry.entry_id)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    hass.data.setdefault(DOMAIN, {})

    # Self-register the bundled frontend (custom_components/boopbasket/www/)
    # so users never add a Lovelace resource by hand. Done first, before the
    # shopping-list wait below, so a slow/missing todo entity can never
    # leave the card unavailable for the rest of this HA run. See
    # www/__init__.py for the registration logic itself.
    frontend_registration = BoopBasketFrontendRegistration(hass)
    await frontend_registration.async_register()
    hass.data[DOMAIN]["frontend_registration"] = frontend_registration

    def _configured(key):
        """Options Flow settings take precedence over the value picked at
        initial setup, so they can be changed later without deleting and
        re-adding the integration."""
        return entry.options.get(key, entry.data.get(key))

    # The shopping list link is entirely optional — Boopbasket is a pantry
    # stock tracker first; the linked list is only used as an optional
    # low-stock reminder (see maybe_add_to_shopping_list_on_low_stock).
    shopping_list_entity = _configured("shopping_list_entity")
    if shopping_list_entity:
        for attempt in range(15):
            todo_states = [state.entity_id for state in hass.states.async_all() if state.entity_id.startswith("todo.")]
            if shopping_list_entity in todo_states:
                _LOGGER.info("✅ Shopping list '%s' ready", shopping_list_entity)
                break
            _LOGGER.info("⏳ Waiting for todo lists... (%s/15)", attempt + 1)
            await asyncio.sleep(2)
        else:
            # Non-fatal: only the low-stock reminder feature is affected,
            # everything else about pantry tracking still works fine.
            _LOGGER.warning(
                "⚠️ Shopping list '%s' not available after 30s — continuing "
                "without low-stock list integration for this session",
                shopping_list_entity
            )
            shopping_list_entity = None
    else:
        _LOGGER.info("No shopping list linked — low-stock list integration disabled")

    hass.data[DOMAIN]["shopping_list_entity"] = shopping_list_entity
    hass.data[DOMAIN]["stock_in_entity"] = _configured("stock_in_entity")
    hass.data[DOMAIN]["stock_out_entity"] = _configured("stock_out_entity")
    hass.data[DOMAIN]["config_entry"] = entry

    # Structured cache
    cache_path = await get_cache_path(hass)
    cache = BarcodeCache(cache_path, hass)
    await cache.load()
    hass.data[DOMAIN]["cache"] = cache
    _LOGGER.info("📂 Cache ready at: %s", cache_path)

    # REST API endpoints — registered once per HA process lifetime, not
    # once per (re)load. There's no unregister API for these routes, and
    # an Options Flow save now reloads this entry, which would otherwise
    # try to register the same URLs again. Each view looks up the current
    # cache from hass.data at request time rather than closing over one at
    # construction, so a reload's fresh cache is always the one actually
    # served, instead of the views staying bound to a stale first-boot one.
    if not hass.data.get("_boopbasket_http_views_registered"):
        hass.http.register_view(BarcodeListView(hass))
        hass.http.register_view(BarcodeCacheAddView(hass))
        hass.http.register_view(BarcodeCacheRemoveView(hass))
        hass.http.register_view(BarcodeLookupView(hass))
        hass.http.register_view(BoopBasketConfigView(hass))
        hass.data["_boopbasket_http_views_registered"] = True
        _LOGGER.info("🌐 REST APIs registered")

    # # SERVICES
    async def _get_active_todo_item_names(target_entity: str) -> set:
        """Case-insensitive names of items currently needs_action on target_entity."""
        try:
            response = await hass.services.async_call(
                "todo", "get_items",
                {"entity_id": target_entity},
                return_response=True,
                blocking=True
            )
            items = (response or {}).get(target_entity, {}).get('items', [])
            return {
                item["summary"].lower().strip()
                for item in items
                if isinstance(item, dict) and item.get("status") == "needs_action"
            }
        except Exception as e:
            _LOGGER.warning("Todo check failed: %s", e)
            return set()

    async def maybe_add_to_shopping_list_on_low_stock(barcode: str, entry_data: Optional[Dict[str, Any]]):
        """Push to the linked shopping list when a product's stock drops to
        or below its low-stock threshold. Purely one-directional — this
        never reads from the list to influence stock, it's just a reminder
        that fires whenever stock is set (add_mapping, adjust_stock, or a
        scan event)."""
        if not entry_data or entry_data.get("status") != "complete":
            return
        target_entity = hass.data[DOMAIN].get("shopping_list_entity")
        if not target_entity:
            return
        stock = entry_data.get("stock", entry_data.get("quantity", 0))
        threshold = entry_data.get("low_stock_threshold", 0)
        if stock > threshold:
            return
        name = entry_data.get("name", barcode)
        active = await _get_active_todo_item_names(target_entity)
        if name.lower().strip() in active:
            _LOGGER.info("📉 '%s' low (stock=%d ≤ %d), already on %s", name, stock, threshold, target_entity)
            return
        _LOGGER.info("📉 '%s' low (stock=%d ≤ %d) → adding to %s", name, stock, threshold, target_entity)
        await hass.services.async_call(
            "todo", "add_item",
            {"entity_id": target_entity, "item": name},
            blocking=True
        )

    async def add_mapping_service(call):
        barcode = str(call.data.get("code") or call.data.get("barcode", "")).strip()
        name = str(call.data.get("product_name") or call.data.get("product", "")).strip()

        _LOGGER.debug("🖥️ add_mapping called: %s → %s", barcode, name)

        if not barcode or not name:
            _LOGGER.warning("add_mapping: missing code/barcode or product_name/product")
            return

        cache = hass.data[DOMAIN]["cache"]
        old_entry = await cache.get(barcode)
        old_name = old_entry.get("name") if old_entry else barcode

        # How many units are on hand — the Add/Edit dialogs always send
        # this explicitly (pre-filled with the current value), so the user
        # is in full control of it; fall back to the prior value (or 0 for
        # a brand-new mapping) only for callers that don't send it at all.
        try:
            stock = max(0, int(call.data.get("stock")))
        except (TypeError, ValueError):
            stock = old_entry.get("stock", old_entry.get("quantity", 0)) if old_entry else 0

        try:
            low_stock_threshold = max(0, int(call.data.get("low_stock_threshold")))
        except (TypeError, ValueError):
            low_stock_threshold = old_entry.get("low_stock_threshold", 0) if old_entry else 0

        # Build OFF-compatible product_data (backwards + forwards compatible)
        product_data = {
            "name": name,
            "brands": call.data.get("brands", ""),
            "package_size": call.data.get("package_size", ""),
            "source": call.data.get("source", "manual"),
            "stock": stock,
            "low_stock_threshold": low_stock_threshold,
            "local_override": True
        }

        await cache.set_product(barcode, product_data)
        # Both the Add and Edit dialogs share this service; any path that
        # sets stock should honor the threshold, so this always runs.
        await maybe_add_to_shopping_list_on_low_stock(barcode, await cache.get(barcode))

        # Sync the shopping list item's text if the product was renamed
        shopping_list_entity = hass.data[DOMAIN].get("shopping_list_entity")
        if old_name != name and shopping_list_entity:
            _LOGGER.debug("add_mapping: syncing shopping list %s → %s", old_name, name)

            try:
                response = await hass.services.async_call(
                    "todo", "get_items", {"entity_id": shopping_list_entity, "status": "needs_action"},
                    return_response=True, blocking=True
                )
                items = response.get(shopping_list_entity, {}).get('items', [])
                matching_items = [item for item in items if old_name in item.get("summary", "") or barcode in item.get("summary", "")]

                for item in matching_items:
                    await hass.services.async_call(
                        "todo", "update_item",
                        {"entity_id": shopping_list_entity, "item": old_name, "rename": name, "status": "needs_action"},
                        blocking=True
                    )

                if matching_items:
                    _LOGGER.info("🔄 Synced %d items: %s → %s", len(matching_items), old_name, name)
            except Exception as e:
                _LOGGER.error("Shopping list sync FAILED: %s", str(e))

        _LOGGER.info("🖥️ Updated: %s → %s", barcode, name)

    async def adjust_stock_service(call):
        barcode = str(call.data.get("barcode", "")).strip()
        if not barcode:
            _LOGGER.warning("adjust_stock: missing barcode")
            return
        try:
            delta = int(call.data["delta"])
        except (TypeError, ValueError, KeyError):
            _LOGGER.warning("adjust_stock: invalid/missing delta")
            return

        cache = hass.data[DOMAIN]["cache"]
        new_stock = await cache.adjust_stock(barcode, delta)
        if new_stock is None:
            _LOGGER.warning("adjust_stock: unknown barcode %s", barcode)
            return
        _LOGGER.info("🔢 %s stock → %d", barcode, new_stock)
        await maybe_add_to_shopping_list_on_low_stock(barcode, await cache.get(barcode))

    async def remove_mapping_service(call):
        barcode = str(call.data["barcode"]).strip()
        if barcode:
            cache = hass.data[DOMAIN]["cache"]
            await cache.remove(barcode)
            _LOGGER.info("🖥️ Removed: %s", barcode)

    hass.services.async_register(DOMAIN, "add_mapping", add_mapping_service)
    hass.services.async_register(DOMAIN, "remove_mapping", remove_mapping_service)
    hass.services.async_register(DOMAIN, "adjust_stock", adjust_stock_service)

    # Handle barcode_scanned events. This is a public extension point for
    # external automations (e.g. a manually-wired USB/Bluetooth scanner),
    # not just the two configurable scanner entities below — those are
    # just a convenience that fires this same event. direction defaults to
    # "in" so anything already firing this event without one keeps working.
    async def handle_barcode(event):
        barcode = event.data.get("barcode", "").strip()
        direction = event.data.get("direction", "in")
        if direction not in ("in", "out"):
            _LOGGER.warning("barcode_scanned: unknown direction %r, treating as 'in'", direction)
            direction = "in"

        invalid_states = {"unavailable", "unknown", "none", ""}
        if not barcode or barcode in invalid_states:
            _LOGGER.debug("Skipping invalid barcode event: %r", barcode)
            return

        if not is_valid_barcode(barcode):
            _LOGGER.debug("❌ QR/Rejected: '%s'", barcode)
            return

        cache = hass.data[DOMAIN]["cache"]
        entry = await cache.get(barcode)

        if entry and entry.get("status") == "complete":
            product = entry.get("name")
            _LOGGER.info("💾 Cache hit %s → %s", barcode, product)
        else:
            product_data = await lookup_product(hass, barcode)
            if product_data:
                await cache.set_product(barcode, product_data)
                product = product_data["name"]
                _LOGGER.info("🌐 API success %s → %s", barcode, product)
            else:
                await cache.set_unknown(barcode)
                product = barcode
                _LOGGER.warning("❓ Unknown: %s", barcode)

        await asyncio.sleep(1)
        delta = 1 if direction == "in" else -1
        await cache.adjust_stock(barcode, delta)
        await maybe_add_to_shopping_list_on_low_stock(barcode, await cache.get(barcode))

    unsub_event = hass.bus.async_listen("barcode_scanned", handle_barcode)
    hass.data[DOMAIN]["unsub_event"] = unsub_event

    # Configurable stock-in/stock-out scanner entities — e.g. a scanner
    # mounted near the pantry shelf (stock-in) vs. one near a bin
    # (stock-out), set via the Options Flow. Replaces the old hardcoded
    # "any entity_id containing dustbin_barcode" assumption, which baked
    # in one specific physical setup and a single fixed direction.
    @callback
    def _handle_scanner_state(event):
        entity_id = event.data.get("entity_id")
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None or new_state.state in ("", "unknown", "unavailable", "none"):
            return
        if old_state is not None and old_state.state == new_state.state:
            return
        barcode = new_state.state.strip()
        direction = "in" if entity_id == hass.data[DOMAIN].get("stock_in_entity") else "out"
        hass.bus.async_fire("barcode_scanned", {"barcode": barcode, "direction": direction})
        _LOGGER.info("🔗 %s scanner → barcode_scanned (%s): %s", direction, direction, barcode)

    scanner_entities = [
        e for e in (hass.data[DOMAIN]["stock_in_entity"], hass.data[DOMAIN]["stock_out_entity"]) if e
    ]
    hass.data[DOMAIN]["scanner_listener"] = (
        async_track_state_change_event(hass, scanner_entities, _handle_scanner_state)
        if scanner_entities else None
    )

    # Options Flow changes (shopping list link, scanner entities) take
    # effect via a reload, same as any other config entry change.
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    _LOGGER.info("🚀 Boopbasket initialized")
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry):
    listeners = hass.data.get(DOMAIN, {})
    scanner_listener = listeners.pop("scanner_listener", None)
    if scanner_listener:
        scanner_listener()
    unsub_event = listeners.pop("unsub_event", None)
    if unsub_event:
        unsub_event()
    frontend_registration = listeners.pop("frontend_registration", None)
    if frontend_registration:
        await frontend_registration.async_unregister()
    hass.data.pop(DOMAIN, None)
    return True
