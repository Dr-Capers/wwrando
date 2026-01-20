from __future__ import annotations

import typing
from enum import Enum

from options.wwrando_options import Options
from wwrando_paths import IS_RUNNING_FROM_SOURCE
from wwr_ui.inventory import INVENTORY_ITEMS, DEFAULT_STARTING_ITEMS, DEFAULT_RANDOMIZED_ITEMS


UI_TABS = [
  {
    "id": "randomizer_settings",
    "title": "Randomizer Settings",
    "sections": [
      {
        "id": "paths",
        "title": "Paths",
        "fields": ["clean_iso_path", "output_folder", "seed"],
      },
      {
        "id": "progression_locations",
        "title": "Progression Locations: Where Should Progress Items Be Placed?",
        "fields": [
          "progression_dungeons",
          "progression_puzzle_secret_caves",
          "progression_combat_secret_caves",
          "progression_savage_labyrinth",
          "progression_island_puzzles",
          "progression_dungeon_secrets",
          "progression_tingle_chests",
          "progression_great_fairies",
          "progression_submarines",
          "progression_platforms_rafts",
          "progression_short_sidequests",
          "progression_long_sidequests",
          "progression_spoils_trading",
          "progression_eye_reef_chests",
          "progression_big_octos_gunboats",
          "progression_misc",
          "progression_minigames",
          "progression_battlesquid",
          "progression_free_gifts",
          "progression_mail",
          "progression_expensive_purchases",
          "progression_triforce_charts",
          "progression_treasure_charts",
        ],
      },
      {
        "id": "item_randomizer_modes",
        "title": "Item Randomizer Modes",
        "fields": [
          "sword_mode",
          "num_starting_triforce_shards",
          "keylunacy",
          "chest_type_matches_contents",
          "trap_chests",
        ],
      },
      {
        "id": "entrance_randomizer_options",
        "title": "Entrance Randomizer Options",
        "fields": [
          "randomize_dungeon_entrances",
          "randomize_boss_entrances",
          "randomize_miniboss_entrances",
          "randomize_secret_cave_entrances",
          "randomize_secret_cave_inner_entrances",
          "randomize_fairy_fountain_entrances",
          "mix_entrances",
        ],
      },
      {
        "id": "other_randomizers",
        "title": "Other Randomizers",
        "fields": [
          "randomize_starting_island",
          "randomize_charts",
          "randomize_enemy_palettes",
          "randomize_enemies",
        ],
      },
      {
        "id": "convenience_tweaks",
        "title": "Convenience Tweaks",
        "fields": [
          "swift_sail",
          "instant_text_boxes",
          "switch_targeting_mode",
          "reveal_full_sea_chart",
          "invert_sea_compass_x_axis",
          "skip_rematch_bosses",
          "add_shortcut_warps_between_dungeons",
          "remove_title_and_ending_videos",
          "remove_music",
          "invert_camera_x_axis",
        ],
      },
    ],
  },
  {
    "id": "starting_items",
    "title": "Starting Items",
    "sections": [
      {
        "id": "starting_gear",
        "title": "Starting Gear",
        "fields": [
          "randomized_gear",
          "starting_gear",
        ],
      },
      {
        "id": "starting_health",
        "title": "Starting Health",
        "fields": [
          "starting_hcs",
          "starting_pohs",
        ],
      },
      {
        "id": "extra_starting_items",
        "title": "Extra Random Starting Items",
        "fields": [
          "num_extra_starting_items",
        ],
      },
    ],
  },
  {
    "id": "advanced_options",
    "title": "Advanced Options",
    "sections": [
      {
        "id": "required_bosses",
        "title": "Required Bosses",
        "fields": [
          "required_bosses",
          "num_required_bosses",
        ],
      },
      {
        "id": "difficulty_options",
        "title": "Difficulty Options",
        "fields": [
          "hero_mode",
          "logic_obscurity",
          "logic_precision",
        ],
      },
      {
        "id": "hint_options",
        "title": "Hint Options",
        "fields": [
          "hoho_hints",
          "fishmen_hints",
          "korl_hints",
          "num_item_hints",
          "num_location_hints",
          "num_barren_hints",
          "num_path_hints",
          "cryptic_hints",
          "prioritize_remote_hints",
          "hint_importance",
        ],
      },
      {
        "id": "additional_advanced_options",
        "title": "Additional Advanced Options",
        "fields": [
          "do_not_generate_spoiler_log",
          "dry_run",
        ],
      },
    ],
  },
  {
    "id": "player_customization",
    "title": "Player Customization",
    "sections": [
      {
        "id": "player_customization_main",
        "title": "Player Customization",
        "fields": [
          "custom_player_model",
          "player_in_casual_clothes",
          "disable_custom_player_voice",
          "disable_custom_player_items",
          "custom_color_preset",
          "custom_colors",
        ],
      },
    ],
  },
]


def _normalize_type_name(option_type: type) -> str:
  if issubclass(option_type, bool):
    return "bool"
  if issubclass(option_type, int):
    return "int"
  if issubclass(option_type, str):
    return "str"
  if issubclass(option_type, Enum):
    return "enum"
  if option_type is list:
    return "list"
  if option_type is dict:
    return "dict"
  return option_type.__name__


def _get_enum_values(option_type: type) -> list[str]:
  if issubclass(option_type, Enum):
    return [value.value for value in option_type]
  return []


def build_option_schema() -> dict:
  defaults = Options()
  schema: dict[str, dict] = {}
  for option in Options.all():
    option_type = typing.get_origin(option.type) or option.type
    schema[option.name] = {
      "name": option.name,
      "type": _normalize_type_name(option_type),
      "default": getattr(defaults, option.name),
      "description": option.description,
      "choice_descriptions": option.choice_descriptions,
      "minimum": option.minimum,
      "maximum": option.maximum,
      "permalink": option.permalink,
      "hidden": option.hidden,
      "unbeatable": option.unbeatable,
      "enum_values": _get_enum_values(option_type),
    }
  return schema


def build_inventory_schema() -> dict:
  return {
    "inventory_items": INVENTORY_ITEMS,
    "default_starting_items": DEFAULT_STARTING_ITEMS,
    "default_randomized_items": DEFAULT_RANDOMIZED_ITEMS,
  }


def build_ui_schema() -> dict:
  return {
    "system": {
      "is_running_from_source": IS_RUNNING_FROM_SOURCE,
    },
    "tabs": UI_TABS,
    "options": build_option_schema(),
    "inventory": build_inventory_schema(),
  }
