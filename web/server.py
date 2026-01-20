from __future__ import annotations

import io
import os
import shutil
import sys
import threading
import uuid
import zipfile
from types import SimpleNamespace
import traceback

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gclib"))

from customizer import get_model_preview_image, get_model_metadata, get_all_custom_model_names
from logic.logic import Logic
from options.wwrando_options import Options
from randomizer import (
  WWRandomizer,
  TooFewProgressionLocationsError,
  InvalidCleanISOError,
  PermalinkWrongVersionError,
  PermalinkWrongCommitError,
)
from seedgen import seedgen
from wwrando_paths import RANDO_ROOT_PATH
from web.settings_store import build_default_settings, load_settings, save_settings, normalize_options
from web.ui_schema import build_ui_schema


BASE_ISO_PATH = os.path.join(RANDO_ROOT_PATH, "data", "local", "iso_cache", "base.iso")
OUTPUT_DIR = os.path.join(RANDO_ROOT_PATH, "data", "local", "output")
LOGS_DIR = os.path.join(RANDO_ROOT_PATH, "data", "local", "logs")
SETTINGS_PATH = os.path.join(RANDO_ROOT_PATH, "data", "local", "web_settings.yml")

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)


app = FastAPI()
app.mount("/static", StaticFiles(directory=os.path.join(RANDO_ROOT_PATH, "web", "static")), name="static")

_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def _default_cmd_args() -> SimpleNamespace:
  return SimpleNamespace(
    dry=False,
    disassemble=False,
    exportfolder=False,
    nologs=False,
    bulk=False,
    printflags=False,
    noitemrando=False,
    mapselect=False,
    heap=False,
    test=None,
    profile=False,
  )


def _load_settings() -> dict:
  defaults = build_default_settings(BASE_ISO_PATH, OUTPUT_DIR)
  return load_settings(SETTINGS_PATH, defaults)


def _save_settings(settings: dict) -> None:
  settings["clean_iso_path"] = BASE_ISO_PATH
  save_settings(SETTINGS_PATH, settings)


def _run_randomizer(job_id: str, seed: str, options_payload: dict, output_folder: str) -> None:
  with _jobs_lock:
    _jobs[job_id]["status"] = "running"

  try:
    options = normalize_options(options_payload)
    cmd_args = _default_cmd_args()
    rando = WWRandomizer(seed, BASE_ISO_PATH, output_folder, options, cmd_line_args=cmd_args)
    rando.randomize_all()
    result = {
      "status": "complete",
      "seed": rando.seed,
      "permalink": rando.permalink,
      "output_folder": output_folder,
      "logs_folder": rando.logs_output_folder,
      "dry_run": rando.dry_run,
    }
  except (TooFewProgressionLocationsError, InvalidCleanISOError) as e:
    result = {"status": "failed", "error": str(e)}
  except Exception as e:
    result = {
      "status": "failed",
      "error": f"{type(e).__name__}: {e}",
      "traceback": traceback.format_exc(),
    }

  with _jobs_lock:
    _jobs[job_id].update(result)


@app.get("/")
def index():
  return FileResponse(os.path.join(RANDO_ROOT_PATH, "web", "static", "index.html"))


@app.get("/api/schema")
def api_schema():
  return build_ui_schema()


@app.get("/api/settings")
def get_settings():
  return _load_settings()

@app.get("/api/settings/defaults")
def get_settings_defaults():
  return build_default_settings(BASE_ISO_PATH, OUTPUT_DIR)


@app.post("/api/settings")
def set_settings(payload: dict):
  settings = _load_settings()
  settings.update(payload)
  _save_settings(settings)
  return settings


@app.get("/api/iso/status")
def iso_status():
  return {
    "path": BASE_ISO_PATH,
    "exists": os.path.isfile(BASE_ISO_PATH),
    "size_bytes": os.path.getsize(BASE_ISO_PATH) if os.path.isfile(BASE_ISO_PATH) else None,
  }


@app.post("/api/paths/validate")
def validate_paths(payload: dict):
  output_folder = payload.get("output_folder") or _load_settings().get("output_folder", OUTPUT_DIR)
  return {
    "base_iso_exists": os.path.isfile(BASE_ISO_PATH),
    "output_folder_exists": os.path.isdir(output_folder),
    "output_folder": output_folder,
  }


@app.get("/api/runs/recent")
def recent_runs(limit: int = 10):
  output_folder = _load_settings().get("output_folder", OUTPUT_DIR)
  if not os.path.isdir(output_folder):
    return {"outputs": [], "logs": []}

  output_entries = []
  log_entries = []
  for entry in os.scandir(output_folder):
    if not entry.is_file():
      continue
    name = entry.name
    stat = entry.stat()
    record = {
      "name": name,
      "size_bytes": stat.st_size,
      "modified": stat.st_mtime,
    }
    lower = name.lower()
    if lower.endswith((".iso", ".gcm", ".zip")):
      output_entries.append(record)
    if lower.endswith((".txt", ".log", ".yml", ".yaml", ".json")) or "log" in lower:
      log_entries.append(record)

  output_entries.sort(key=lambda item: item["modified"], reverse=True)
  log_entries.sort(key=lambda item: item["modified"], reverse=True)

  return {
    "outputs": output_entries[:limit],
    "logs": log_entries[:limit],
  }


@app.get("/api/files/output/{filename}")
def download_output_file(filename: str):
  if os.path.basename(filename) != filename:
    raise HTTPException(status_code=400, detail="Invalid filename")
  output_folder = _load_settings().get("output_folder", OUTPUT_DIR)
  path = os.path.join(output_folder, filename)
  if not os.path.isfile(path):
    raise HTTPException(status_code=404, detail="File not found")
  return FileResponse(path, filename=filename)


@app.post("/api/progression_locations")
def progression_locations(payload: dict):
  options = normalize_options(payload)
  cached_item_locations = Logic.load_and_parse_item_locations()
  count = Logic.get_num_progression_locations_static(cached_item_locations, options)
  return {"count": count}


@app.post("/api/run")
def run_randomizer(payload: dict):
  if not os.path.isfile(BASE_ISO_PATH):
    raise HTTPException(status_code=400, detail="Missing base ISO at data/local/iso_cache/base.iso")

  settings = _load_settings()
  seed = payload.get("seed", settings.get("seed", ""))
  options = payload.get("options", settings)
  options_payload = {option.name: options.get(option.name) for option in Options.all()}
  output_folder = options.get("output_folder", settings.get("output_folder", OUTPUT_DIR))
  if not os.path.isdir(output_folder):
    raise HTTPException(status_code=400, detail=f"Output folder does not exist: {output_folder}")

  job_id = str(uuid.uuid4())
  with _jobs_lock:
    _jobs[job_id] = {
      "status": "queued",
      "seed": seed,
    }
  thread = threading.Thread(target=_run_randomizer, args=(job_id, seed, options_payload, output_folder), daemon=True)
  thread.start()

  return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
  with _jobs_lock:
    job = _jobs.get(job_id)
  if not job:
    raise HTTPException(status_code=404, detail="Unknown job")
  return job


@app.get("/api/custom_models")
def custom_models():
  model_names = get_all_custom_model_names()
  return {"models": ["Link"] + model_names}


@app.get("/api/custom_models/{model_name}")
def custom_model_metadata(model_name: str):
  if model_name not in ["Link", "Random", "Random (exclude Link)"] and model_name not in get_all_custom_model_names():
    raise HTTPException(status_code=404, detail="Unknown model")
  return get_model_metadata(model_name)


@app.get("/api/custom_models/{model_name}/preview")
def custom_model_preview(model_name: str, prefix: str = "hero", colors: str | None = None):
  if model_name not in ["Link", "Random", "Random (exclude Link)"] and model_name not in get_all_custom_model_names():
    raise HTTPException(status_code=404, detail="Unknown model")

  selected_colors = {}
  if colors:
    for entry in colors.split(","):
      if ":" not in entry:
        continue
      color_name, color_value = entry.split(":", 1)
      parts = color_value.split("-")
      if len(parts) != 3:
        continue
      try:
        selected_colors[color_name] = [int(parts[0]), int(parts[1]), int(parts[2])]
      except ValueError:
        continue

  preview_image = get_model_preview_image(model_name, prefix, selected_colors)
  if preview_image is None:
    raise HTTPException(status_code=404, detail="No preview available")

  buffer = io.BytesIO()
  preview_image.save(buffer, format="PNG")
  buffer.seek(0)
  return StreamingResponse(buffer, media_type="image/png")


@app.post("/api/seed")
def generate_seed():
  seed = seedgen.make_random_seed_name()
  return {"seed": WWRandomizer.sanitize_seed(seed)}


@app.post("/api/permalink/encode")
def encode_permalink(payload: dict):
  seed = payload.get("seed", "")
  options_payload = payload.get("options", {})
  options = normalize_options(options_payload)
  seed = WWRandomizer.sanitize_seed(seed)
  if not seed:
    return {"permalink": ""}
  return {"permalink": WWRandomizer.encode_permalink(seed, options)}


@app.post("/api/permalink/decode")
def decode_permalink(payload: dict):
  permalink = payload.get("permalink", "").strip()
  options_payload = payload.get("options", {})
  if not permalink:
    return {"seed": "", "options": options_payload}

  try:
    options = normalize_options(options_payload)
    seed, decoded_options = WWRandomizer.decode_permalink(permalink, options)
    return {"seed": seed, "options": decoded_options.dict()}
  except PermalinkWrongVersionError as e:
    raise HTTPException(status_code=400, detail=str(e))
  except PermalinkWrongCommitError as e:
    options = normalize_options(options_payload)
    seed, decoded_options = WWRandomizer.decode_permalink(permalink, options, allow_different_commit=True)
    return {"seed": seed, "options": decoded_options.dict(), "warning": str(e)}


@app.post("/api/custom_models/upload")
def upload_custom_model(file: UploadFile):
  if not file.filename:
    raise HTTPException(status_code=400, detail="No file uploaded")
  if not file.filename.endswith(".zip"):
    raise HTTPException(status_code=400, detail="Expected a .zip file")

  temp_path = os.path.join(LOGS_DIR, f"upload_{uuid.uuid4().hex}.zip")
  with open(temp_path, "wb") as handle:
    shutil.copyfileobj(file.file, handle)

  try:
    install_result = _install_custom_model_zip(temp_path)
  finally:
    if os.path.isfile(temp_path):
      os.remove(temp_path)

  return {"result": install_result, "models": ["Link"] + get_all_custom_model_names()}


@app.post("/api/custom_presets/parse")
def parse_custom_preset(file: UploadFile):
  if not file.filename:
    raise HTTPException(status_code=400, detail="No file uploaded")
  content = file.file.read()
  if not content:
    raise HTTPException(status_code=400, detail="Empty preset file")
  try:
    from ruamel.yaml import YAML
    yaml_loader = YAML(typ="rt")
    data = yaml_loader.load(content)
  except Exception as e:
    raise HTTPException(status_code=400, detail=f"Failed to parse preset: {e}")
  return data


@app.post("/api/custom_presets/render")
def render_custom_preset(payload: dict):
  from ruamel.yaml import YAML
  yaml_loader = YAML(typ="rt")
  buffer = io.StringIO()
  yaml_loader.dump(payload, buffer)
  return JSONResponse({"text": buffer.getvalue()})


@app.get("/api/custom_models/{model_name}/capabilities")
def custom_model_capabilities(model_name: str):
  if model_name not in ["Link", "Random", "Random (exclude Link)"] and model_name not in get_all_custom_model_names():
    raise HTTPException(status_code=404, detail="Unknown model")

  if model_name in ["Random", "Random (exclude Link)"]:
    return {
      "disable_casual_clothes": False,
      "has_custom_voice": True,
      "has_custom_items": True,
      "casual_clothes_option_text": "Casual Clothes",
    }

  metadata = get_model_metadata(model_name)
  disable_casual_clothes = metadata.get("disable_casual_clothes", False)
  casual_clothes_option_text = metadata.get("casual_clothes_option_text", "Casual Clothes")

  custom_model_path = os.path.join(RANDO_ROOT_PATH, "models", model_name)
  jaiinit_aaf_path = os.path.join(custom_model_path, "sound", "JaiInit.aaf")
  voice_aw_path = os.path.join(custom_model_path, "sound", "voice_0.aw")
  has_custom_voice = os.path.isfile(jaiinit_aaf_path) and os.path.isfile(voice_aw_path)
  has_custom_items = model_name != "Link"

  return {
    "disable_casual_clothes": disable_casual_clothes,
    "has_custom_voice": has_custom_voice,
    "has_custom_items": has_custom_items,
    "casual_clothes_option_text": casual_clothes_option_text,
  }


def _install_custom_model_zip(zip_path: str) -> str:
  with zipfile.ZipFile(zip_path) as zip_handle:
    try:
      top_level_dir = zipfile.Path(zip_handle, zip_handle.namelist()[0])
    except IndexError:
      raise HTTPException(status_code=400, detail="Archive is empty")

    if top_level_dir.joinpath("models").is_dir():
      model_path = top_level_dir.joinpath("models")
      model_dir_list = list(model_path.iterdir())
      is_model_pack = True
    else:
      model_dir_list = [top_level_dir]
      is_model_pack = False

    expected_files = ["Link.arc", "metadata.txt"]
    for model_dir in model_dir_list:
      for filename in expected_files:
        if not model_dir.joinpath(filename).exists():
          raise HTTPException(status_code=400, detail=f"Missing file: {model_dir.joinpath(filename).at}")

    zip_handle.extractall(os.path.join(RANDO_ROOT_PATH, "models"))

    if not is_model_pack:
      install_result = model_dir_list[0].name
    else:
      for model_dir in model_dir_list:
        shutil.move(
          os.path.join(RANDO_ROOT_PATH, "models", model_dir.at),
          os.path.join(RANDO_ROOT_PATH, "models", model_dir.name),
        )
      shutil.rmtree(os.path.join(RANDO_ROOT_PATH, "models", top_level_dir.name))
      install_result = f"{len(model_dir_list)} models"

  return install_result
