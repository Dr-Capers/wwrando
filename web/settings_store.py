from __future__ import annotations

from ruamel.yaml import YAML

from options.wwrando_options import Options


_yaml = YAML(typ="rt")


def build_default_settings(clean_iso_path: str, output_folder: str) -> dict:
  options = Options()
  settings = {
    "clean_iso_path": clean_iso_path,
    "output_folder": output_folder,
    "seed": "",
  }
  settings.update(options.dict())
  return settings


def load_settings(path: str, defaults: dict) -> dict:
  try:
    with open(path) as handle:
      data = _yaml.load(handle)
  except FileNotFoundError:
    return defaults.copy()
  if data is None:
    return defaults.copy()

  merged = defaults.copy()
  merged.update(data)
  return merged


def save_settings(path: str, settings: dict) -> None:
  with open(path, "w") as handle:
    _yaml.dump(settings, handle)


def normalize_options(option_payload: dict) -> Options:
  options = Options()
  for option in Options.all():
    if option.name in option_payload:
      setattr(options, option.name, option_payload[option.name])
  options.validate()
  return options
