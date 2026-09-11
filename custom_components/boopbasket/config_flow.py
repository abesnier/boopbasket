"""Config flow for Boopbasket."""
import logging
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

DOMAIN = "boopbasket"

_LOGGER = logging.getLogger(__name__)

class BarcodeShoppingListConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="Only one shopping list allowed")

        errors = {}
        if user_input is not None:
            entity_id = user_input.get("shopping_list_entity")
            if entity_id and not self.hass.states.get(entity_id):
                errors["shopping_list_entity"] = "not_found"
            else:
                return self.async_create_entry(
                    title="Boopbasket",
                    data={"shopping_list_entity": entity_id} if entity_id else {}
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                # Optional: Boopbasket is a pantry stock tracker first, the
                # shopping list is only used as an optional low-stock
                # reminder — it can be linked or changed later from the
                # integration's Configure/Options screen too.
                vol.Optional("shopping_list_entity"):
                    selector.EntitySelector(selector.EntitySelectorConfig(domain="todo"))
            }),
            errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> "BoopBasketOptionsFlow":
        return BoopBasketOptionsFlow()

class BoopBasketOptionsFlow(OptionsFlow):
    """Lets the shopping list link and external scanner entities be
    changed after setup, without deleting and re-adding the integration."""

    async def async_step_init(self, user_input=None):
        errors = {}
        if user_input is not None:
            shopping_list_entity = user_input.get("shopping_list_entity")
            stock_in_entity = user_input.get("stock_in_entity")
            stock_out_entity = user_input.get("stock_out_entity")

            if shopping_list_entity and not self.hass.states.get(shopping_list_entity):
                errors["shopping_list_entity"] = "not_found"
            if stock_in_entity and stock_out_entity and stock_in_entity == stock_out_entity:
                errors["stock_out_entity"] = "same_entity"

            if not errors:
                return self.async_create_entry(
                    title="",
                    data={
                        "shopping_list_entity": shopping_list_entity,
                        "stock_in_entity": stock_in_entity,
                        "stock_out_entity": stock_out_entity,
                    }
                )

        current = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Optional(
                    "shopping_list_entity",
                    description={"suggested_value": current.get("shopping_list_entity")}
                ): selector.EntitySelector(selector.EntitySelectorConfig(domain="todo")),
                # Any entity whose state is the last-scanned barcode — e.g.
                # a DIY/ESPHome scanner mounted near the pantry shelf.
                vol.Optional(
                    "stock_in_entity",
                    description={"suggested_value": current.get("stock_in_entity")}
                ): selector.EntitySelector(selector.EntitySelectorConfig()),
                # Same idea, but for a scanner used to record using up an
                # item (e.g. mounted near a bin) — decrements stock instead.
                vol.Optional(
                    "stock_out_entity",
                    description={"suggested_value": current.get("stock_out_entity")}
                ): selector.EntitySelector(selector.EntitySelectorConfig()),
            }),
            errors=errors
        )
