const state = {
  schema: null,
  settings: null,
  activeTab: null,
  selectedGear: {
    randomized_gear: new Set(),
    starting_gear: new Set(),
  },
  customModelMetadata: {},
  customModelCaps: {},
  customModelList: [],
  validation: {
    baseIsoExists: false,
    outputFolderExists: true,
    outputFolder: "",
  },
  uiFlags: {
    showHidden: false,
    showUnbeatable: false,
  },
  lastJobId: null,
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

async function init() {
  state.schema = await fetchJson("/api/schema");
  state.settings = await fetchJson("/api/settings");
  const models = await fetchJson("/api/custom_models");
  state.customModelList = models.models.filter((model) => model !== "Link");

  const tabs = state.schema.tabs;
  state.activeTab = tabs[0].id;
  applyOptionRules();
  renderTabs(tabs);
  renderActiveTab();
  renderIsoStatus();
  wireGlobalActions();
  await refreshValidation();
  await refreshRecentRuns();
}

function wireGlobalActions() {
  document.getElementById("refresh-iso").addEventListener("click", renderIsoStatus);
  document.getElementById("generate-seed").addEventListener("click", generateSeed);
  document.getElementById("reset-defaults").addEventListener("click", resetDefaults);
  document.getElementById("randomize").addEventListener("click", startRandomize);
  document.getElementById("open-output").addEventListener("click", copyOutputPath);
  document.getElementById("refresh-runs").addEventListener("click", refreshRecentRuns);
  document.getElementById("download-latest").addEventListener("click", downloadLatestOutput);

  const permalinkInput = document.getElementById("permalink");
  permalinkInput.addEventListener("change", decodePermalink);

  document.getElementById("show-hidden").addEventListener("change", (event) => {
    state.uiFlags.showHidden = event.target.checked;
    renderActiveTab();
  });

  document.getElementById("show-unbeatable").addEventListener("change", (event) => {
    state.uiFlags.showUnbeatable = event.target.checked;
    renderActiveTab();
  });

  if (!state.schema.system.is_running_from_source) {
    const unbeatableToggle = document.getElementById("show-unbeatable");
    unbeatableToggle.disabled = true;
    unbeatableToggle.checked = false;
  }
}

function renderTabs(tabs) {
  const tabsEl = document.getElementById("tabs");
  tabsEl.innerHTML = "";

  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = `tab-button ${tab.id === state.activeTab ? "active" : ""}`;
    btn.textContent = tab.title;
    btn.addEventListener("click", () => {
      state.activeTab = tab.id;
      renderTabs(tabs);
      renderActiveTab();
    });
    tabsEl.appendChild(btn);
  }
}

function renderActiveTab() {
  const tab = state.schema.tabs.find((t) => t.id === state.activeTab);
  if (!tab) {
    return;
  }
  document.getElementById("panel-title").textContent = tab.title;
  document.getElementById("panel-subtitle").textContent = tab.sections.map((s) => s.title).join(" · ");

  const content = document.getElementById("tab-content");
  content.innerHTML = "";

  for (const section of tab.sections) {
    const sectionEl = document.createElement("div");
    sectionEl.className = "section";
    sectionEl.dataset.sectionId = section.id;

    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = section.title;
    sectionEl.appendChild(title);

    if (section.id === "starting_gear") {
      sectionEl.appendChild(renderGearSection());
    } else if (section.id === "player_customization_main") {
      sectionEl.appendChild(renderCustomizationSection());
    } else {
      sectionEl.appendChild(renderFields(section.fields));
      if (section.id === "starting_health") {
        sectionEl.appendChild(renderHealthSummary());
      }
    }

    content.appendChild(sectionEl);
  }

  updatePermalink();
  updateProgressionLocations();
}

function renderFields(fieldNames) {
  const grid = document.createElement("div");
  grid.className = "field-grid";

  for (const fieldName of fieldNames) {
    const option = state.schema.options[fieldName];
    if (!option) {
      continue;
    }
    if (option.hidden && !state.uiFlags.showHidden && !state.settings[fieldName]) {
      continue;
    }
    if (option.unbeatable && !state.schema.system.is_running_from_source) {
      continue;
    }
    if (option.unbeatable && !state.uiFlags.showUnbeatable) {
      continue;
    }
    grid.appendChild(renderField(option));
  }

  return grid;
}

function renderField(option) {
  const field = document.createElement("div");
  field.className = option.type === "bool" ? "field inline" : "field";

  const label = document.createElement("label");
  label.textContent = labelText(option.name);
  label.htmlFor = option.name;
  label.addEventListener("mouseenter", () => setOptionDescription(option.description));
  label.addEventListener("mouseleave", () => setOptionDescription(null));

  let input;
  if (option.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(state.settings[option.name]);
  } else if (option.type === "int") {
    input = document.createElement("input");
    input.type = "number";
    input.min = option.minimum ?? 0;
    input.max = option.maximum ?? 999;
    input.value = state.settings[option.name];
  } else if (option.type === "enum" || ["custom_player_model", "custom_color_preset"].includes(option.name)) {
    input = document.createElement("select");
    if (option.type === "enum") {
      for (const value of option.enum_values) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        input.appendChild(opt);
      }
      input.value = state.settings[option.name];
    }
  } else {
    input = document.createElement("input");
    input.type = "text";
    input.value = state.settings[option.name] ?? "";
  }

  input.id = option.name;
  input.addEventListener("change", () => {
    state.settings[option.name] = coerceInputValue(option, input);
    applyOptionRules();
    saveSettings();
    if (["custom_player_model", "player_in_casual_clothes", "custom_color_preset"].includes(option.name)) {
      refreshCustomizationUI();
    }
    if (option.name === "seed") {
      updatePermalink();
    }
    if (option.name === "starting_hcs" || option.name === "starting_pohs") {
      updateHealthSummary();
    }
    if (option.name === "output_folder") {
      refreshValidation();
    }
  });

  if (option.name === "clean_iso_path") {
    input.disabled = true;
  }

  field.appendChild(label);
  field.appendChild(input);

  if (option.choice_descriptions && Object.keys(option.choice_descriptions).length) {
    const hint = document.createElement("div");
    hint.className = "muted";
    hint.innerHTML = option.choice_descriptions[state.settings[option.name]] || "";
    input.addEventListener("change", () => {
      hint.innerHTML = option.choice_descriptions[input.value] || "";
    });
    field.appendChild(hint);
  }

  if (option.name === "output_folder") {
    const warning = document.createElement("div");
    warning.className = "field-warning";
    warning.textContent = state.validation.outputFolderExists ? "" : "Output folder does not exist.";
    if (!state.validation.outputFolderExists) {
      input.classList.add("invalid");
    }
    field.appendChild(warning);
  }

  if (option.name === "clean_iso_path") {
    const warning = document.createElement("div");
    warning.className = "field-warning";
    warning.textContent = state.validation.baseIsoExists ? "" : "Missing base ISO at data/local/iso_cache/base.iso.";
    if (!state.validation.baseIsoExists) {
      input.classList.add("invalid");
    }
    field.appendChild(warning);
  }

  return field;
}

function renderGearSection() {
  const container = document.createElement("div");
  container.className = "gear-transfer";
  state.selectedGear.randomized_gear.clear();
  state.selectedGear.starting_gear.clear();

  const left = renderGearList("randomized_gear", "Randomized Gear");
  const right = renderGearList("starting_gear", "Starting Gear");
  const actions = document.createElement("div");
  actions.className = "gear-actions";

  const toStarting = document.createElement("button");
  toStarting.textContent = "→";
  toStarting.addEventListener("click", () => moveGear("randomized_gear", "starting_gear"));

  const toRandomized = document.createElement("button");
  toRandomized.textContent = "←";
  toRandomized.addEventListener("click", () => moveGear("starting_gear", "randomized_gear"));

  actions.appendChild(toStarting);
  actions.appendChild(toRandomized);

  container.appendChild(left);
  container.appendChild(actions);
  container.appendChild(right);
  return container;
}

function renderGearList(name, title) {
  const wrapper = document.createElement("div");
  const label = document.createElement("div");
  label.className = "section-title";
  label.textContent = title;

  const list = document.createElement("div");
  list.className = "gear-list";
  list.dataset.name = name;

  const items = state.settings[name] || [];
  items.forEach((item, index) => {
    const itemEl = document.createElement("div");
    itemEl.className = "gear-item";
    itemEl.textContent = item;
    itemEl.addEventListener("click", () => {
      toggleGearSelection(name, index, itemEl);
    });
    list.appendChild(itemEl);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(list);
  return wrapper;
}

function toggleGearSelection(listName, index, itemEl) {
  const selected = state.selectedGear[listName];
  if (selected.has(index)) {
    selected.delete(index);
    itemEl.classList.remove("selected");
  } else {
    selected.add(index);
    itemEl.classList.add("selected");
  }
}

function moveGear(from, to) {
  const moved = Array.from(state.selectedGear[from]).sort((a, b) => b - a);
  if (!moved.length) {
    return;
  }
  const fromList = state.settings[from];
  const toList = state.settings[to];

  for (const index of moved) {
    const item = fromList[index];
    if (item !== undefined) {
      fromList.splice(index, 1);
      toList.push(item);
    }
  }
  state.selectedGear[from].clear();
  toList.sort();
  fromList.sort();
  applyOptionRules();
  saveSettings();
  renderActiveTab();
}

function renderCustomizationSection() {
  const container = document.createElement("div");
  container.className = "field-grid";

  const modelSelect = renderField(state.schema.options.custom_player_model);
  const modelSelectInput = modelSelect.querySelector("select") || modelSelect.querySelector("input");
  modelSelectInput.innerHTML = "";

  const modelNames = ["Link", ...state.customModelList];
  if (state.customModelList.length) {
    modelNames.push("Random", "Random (exclude Link)");
  }

  for (const model of modelNames) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    modelSelectInput.appendChild(opt);
  }
  modelSelectInput.value = state.settings.custom_player_model || "Link";

  container.appendChild(modelSelect);
  container.appendChild(renderField(state.schema.options.player_in_casual_clothes));
  container.appendChild(renderField(state.schema.options.disable_custom_player_voice));
  container.appendChild(renderField(state.schema.options.disable_custom_player_items));

  const presetField = renderField(state.schema.options.custom_color_preset);
  container.appendChild(presetField);

  const buttonRow = document.createElement("div");
  buttonRow.className = "field-grid full-span";

  const installBtn = document.createElement("button");
  installBtn.textContent = "Install Custom Model Zip";
  installBtn.addEventListener("click", () => uploadCustomModel());

  const randomOrderly = document.createElement("button");
  randomOrderly.textContent = "Random (Orderly)";
  randomOrderly.addEventListener("click", () => randomizeColors(true));

  const randomChaotic = document.createElement("button");
  randomChaotic.textContent = "Random (Chaotically)";
  randomChaotic.addEventListener("click", () => randomizeColors(false));

  const savePreset = document.createElement("button");
  savePreset.textContent = "Save Custom Preset";
  savePreset.dataset.action = "save-preset";
  savePreset.addEventListener("click", () => saveCustomPreset());

  const loadPreset = document.createElement("button");
  loadPreset.textContent = "Load Custom Preset";
  loadPreset.addEventListener("click", () => loadCustomPreset());

  buttonRow.appendChild(installBtn);
  buttonRow.appendChild(randomOrderly);
  buttonRow.appendChild(randomChaotic);
  buttonRow.appendChild(savePreset);
  buttonRow.appendChild(loadPreset);

  const colorsWrap = document.createElement("div");
  colorsWrap.className = "color-grid full-span";
  colorsWrap.id = "color-grid";

  const preview = document.createElement("div");
  preview.className = "preview full-span";
  preview.innerHTML = `<img id="model-preview" alt="Model preview" />`;

  const comment = document.createElement("div");
  comment.id = "model-comment";
  comment.className = "muted full-span";

  container.appendChild(buttonRow);
  container.appendChild(comment);
  container.appendChild(colorsWrap);
  container.appendChild(preview);

  refreshCustomizationUI();
  return container;
}

function renderHealthSummary() {
  const wrapper = document.createElement("div");
  wrapper.className = "muted";
  wrapper.id = "health-summary";

  const pohs = Number(state.settings.starting_pohs || 0);
  const hcs = Number(state.settings.starting_hcs || 0) * 4;
  const health = hcs + pohs;
  const pieces = health % 4;

  let text = `Current Starting Health: ${Math.floor(health / 4)} hearts`;
  if (pieces) {
    text += pieces === 1 ? " and 1 piece" : ` and ${pieces} pieces`;
  }
  wrapper.textContent = text;
  return wrapper;
}

function updateHealthSummary() {
  const el = document.getElementById("health-summary");
  if (!el) {
    return;
  }
  const pohs = Number(state.settings.starting_pohs || 0);
  const hcs = Number(state.settings.starting_hcs || 0) * 4;
  const health = hcs + pohs;
  const pieces = health % 4;

  let text = `Current Starting Health: ${Math.floor(health / 4)} hearts`;
  if (pieces) {
    text += pieces === 1 ? " and 1 piece" : ` and ${pieces} pieces`;
  }
  el.textContent = text;
}

async function refreshCustomizationUI() {
  const modelName = state.settings.custom_player_model || "Link";
  if (!state.customModelMetadata[modelName]) {
    state.customModelMetadata[modelName] = await fetchJson(`/api/custom_models/${encodeURIComponent(modelName)}`);
  }
  if (!state.customModelCaps[modelName]) {
    state.customModelCaps[modelName] = await fetchJson(`/api/custom_models/${encodeURIComponent(modelName)}/capabilities`);
  }

  const metadata = state.customModelMetadata[modelName];
  const caps = state.customModelCaps[modelName];
  let dirty = false;

  const casualCheckbox = document.getElementById("player_in_casual_clothes");
  const voiceCheckbox = document.getElementById("disable_custom_player_voice");
  const itemsCheckbox = document.getElementById("disable_custom_player_items");
  const casualLabel = document.querySelector("label[for='player_in_casual_clothes']");

  casualCheckbox.disabled = caps.disable_casual_clothes;
  if (caps.disable_casual_clothes) {
    if (state.settings.player_in_casual_clothes) {
      state.settings.player_in_casual_clothes = false;
      dirty = true;
    }
    casualCheckbox.checked = false;
  }
  if (casualLabel) {
    casualLabel.textContent = caps.casual_clothes_option_text || "Casual Clothes";
  }
  voiceCheckbox.disabled = !caps.has_custom_voice;
  if (!caps.has_custom_voice && state.settings.disable_custom_player_voice) {
    state.settings.disable_custom_player_voice = false;
    voiceCheckbox.checked = false;
    dirty = true;
  }
  itemsCheckbox.disabled = !caps.has_custom_items;
  if (!caps.has_custom_items && state.settings.disable_custom_player_items) {
    state.settings.disable_custom_player_items = false;
    itemsCheckbox.checked = false;
    dirty = true;
  }

  const presetSelect = document.getElementById("custom_color_preset");
  const presets = getPresetsForModel(metadata);
  presetSelect.innerHTML = "";
  ["Default", "Custom", ...Object.keys(presets)].forEach((preset) => {
    const opt = document.createElement("option");
    opt.value = preset;
    opt.textContent = preset;
    presetSelect.appendChild(opt);
  });

  const desiredPreset = state.settings.custom_color_preset || "Default";
  const fallbackPreset = presetSelect.querySelector(`option[value="${desiredPreset}"]`) ? desiredPreset : "Default";
  if (state.settings.custom_color_preset !== fallbackPreset) {
    state.settings.custom_color_preset = fallbackPreset;
    dirty = true;
  }
  presetSelect.value = fallbackPreset;

  const comment = document.getElementById("model-comment");
  if (comment) {
    const commentLines = [];
    if (metadata.author) {
      commentLines.push(`Author: ${metadata.author}`);
    }
    if (metadata.comment) {
      commentLines.push(`Author's comment: ${metadata.comment}`);
    }
    comment.textContent = commentLines.join("\n");
    comment.style.display = commentLines.length ? "block" : "none";
  }

  const savePresetBtn = document.querySelector("button[data-action='save-preset']");
  if (savePresetBtn) {
    savePresetBtn.disabled = ["Random", "Random (exclude Link)"].includes(modelName);
  }

  renderColorGrid(metadata);
  updateModelPreview();

  if (dirty) {
    await saveSettings();
  }
}

function renderColorGrid(metadata) {
  const grid = document.getElementById("color-grid");
  grid.innerHTML = "";

  const prefix = state.settings.player_in_casual_clothes ? "casual" : "hero";
  const colors = metadata[`${prefix}_custom_colors`] || {};

  if (!state.settings.custom_colors) {
    state.settings.custom_colors = {};
  }

  Object.entries(colors).forEach(([colorName, rgb]) => {
    const card = document.createElement("div");
    card.className = "color-card";

    const chip = document.createElement("div");
    chip.className = "color-chip";

    const label = document.createElement("span");
    label.textContent = colorName;

    const input = document.createElement("input");
    input.type = "color";
    input.value = rgbToHex(getColorValue(colorName, rgb));
    input.addEventListener("change", () => {
      state.settings.custom_color_preset = "Custom";
      state.settings.custom_colors[colorName] = hexToRgb(input.value);
      updateModelPreview();
      saveSettings();
    });

    chip.appendChild(input);
    chip.appendChild(label);
    card.appendChild(chip);

    const reset = document.createElement("button");
    reset.textContent = "Reset";
    reset.className = "secondary";
    reset.addEventListener("click", () => {
      state.settings.custom_color_preset = "Custom";
      state.settings.custom_colors[colorName] = rgb;
      input.value = rgbToHex(rgb);
      updateModelPreview();
      saveSettings();
    });

    card.appendChild(reset);
    grid.appendChild(card);
  });
}

function getColorValue(colorName, defaultRgb) {
  const preset = state.settings.custom_color_preset || "Default";
  const metadata = state.customModelMetadata[state.settings.custom_player_model];
  const prefix = state.settings.player_in_casual_clothes ? "casual" : "hero";

  if (preset === "Default") {
    return defaultRgb;
  }
  if (preset === "Custom" && state.settings.custom_colors[colorName]) {
    return state.settings.custom_colors[colorName];
  }
  const presets = metadata[`${prefix}_color_presets`] || {};
  if (presets[preset] && presets[preset][colorName]) {
    return presets[preset][colorName];
  }
  return defaultRgb;
}

function getPresetsForModel(metadata) {
  const prefix = state.settings.player_in_casual_clothes ? "casual" : "hero";
  return metadata[`${prefix}_color_presets`] || {};
}

async function updateModelPreview() {
  const img = document.getElementById("model-preview");
  if (!img) {
    return;
  }
  const modelName = state.settings.custom_player_model || "Link";
  const prefix = state.settings.player_in_casual_clothes ? "casual" : "hero";
  const metadata = state.customModelMetadata[modelName];
  const colors = metadata ? (metadata[`${prefix}_custom_colors`] || {}) : {};
  const colorPairs = Object.entries(colors).map(([colorName, rgb]) => {
    const actual = getColorValue(colorName, rgb);
    return `${encodeURIComponent(colorName)}:${actual.join("-")}`;
  });
  const colorQuery = colorPairs.join(",");
  img.onerror = () => {
    img.style.display = "none";
  };
  img.onload = () => {
    img.style.display = "block";
  };
  const url = new URL(`/api/custom_models/${encodeURIComponent(modelName)}/preview`, window.location.origin);
  url.searchParams.set("prefix", prefix);
  if (colorQuery) {
    url.searchParams.set("colors", colorQuery);
  }
  img.src = url.toString();
}

async function uploadCustomModel() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.addEventListener("change", async () => {
    if (!input.files.length) {
      return;
    }
    const formData = new FormData();
    formData.append("file", input.files[0]);
    await fetchJson("/api/custom_models/upload", { method: "POST", body: formData });
    state.customModelList = (await fetchJson("/api/custom_models")).models.filter((m) => m !== "Link");
    renderActiveTab();
  });
  input.click();
}

function randomizeColors(orderly) {
  const metadata = state.customModelMetadata[state.settings.custom_player_model];
  const prefix = state.settings.player_in_casual_clothes ? "casual" : "hero";
  const colors = metadata[`${prefix}_custom_colors`] || {};
  const entries = Object.entries(colors);
  if (!entries.length) {
    return;
  }
  const baseColors = entries.map(([, rgb]) => rgb);
  const randomized = orderly ? shuffleArray(baseColors.slice()) : entries.map(() => randomColor());

  state.settings.custom_color_preset = "Custom";
  state.settings.custom_colors = {};
  entries.forEach(([colorName], idx) => {
    state.settings.custom_colors[colorName] = orderly ? randomized[idx] : randomized[idx];
  });
  renderColorGrid(metadata);
  updateModelPreview();
  saveSettings();
}

function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function randomColor() {
  return [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
}

async function saveCustomPreset() {
  const payload = {
    model_name: state.settings.custom_player_model,
    colors: toHexMap(state.settings.custom_colors || {}),
    is_casual: state.settings.player_in_casual_clothes,
  };
  const response = await fetchJson("/api/custom_presets/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const blob = new Blob([response.text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "custom_colors.txt";
  link.click();
  URL.revokeObjectURL(url);
}

async function loadCustomPreset() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt";
  input.addEventListener("change", async () => {
    if (!input.files.length) {
      return;
    }
    const formData = new FormData();
    formData.append("file", input.files[0]);
    const preset = await fetchJson("/api/custom_presets/parse", { method: "POST", body: formData });

    if (preset.model_name && preset.model_name !== state.settings.custom_player_model) {
      state.settings.custom_player_model = preset.model_name;
    }
    state.settings.player_in_casual_clothes = Boolean(preset.is_casual);
    state.settings.custom_color_preset = "Custom";
    state.settings.custom_colors = parseHexMap(preset.colors || {});

    await saveSettings();
    renderActiveTab();
  });
  input.click();
}

function toHexMap(colors) {
  const result = {};
  Object.entries(colors).forEach(([name, rgb]) => {
    result[name] = `0x${rgbToHex(rgb).slice(1)}`;
  });
  return result;
}

function parseHexMap(colors) {
  const result = {};
  Object.entries(colors).forEach(([name, value]) => {
    const hex = value.replace("0x", "#");
    result[name] = hexToRgb(hex);
  });
  return result;
}

function rgbToHex(rgb) {
  const [r, g, b] = rgb;
  return `#${[r, g, b].map((val) => val.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

async function renderIsoStatus() {
  const statusEl = document.getElementById("iso-status");
  try {
    const status = await fetchJson("/api/iso/status");
    if (!status.exists) {
      statusEl.textContent = "Missing base.iso. Drop it in data/local/iso_cache/base.iso.";
      statusEl.style.color = "#a03a2a";
      return;
    }
    statusEl.textContent = `Ready (${(status.size_bytes / (1024 * 1024)).toFixed(1)} MB)`;
    statusEl.style.color = "#2f7d64";
  } catch (err) {
    statusEl.textContent = "Failed to check ISO status.";
    statusEl.style.color = "#a03a2a";
  }
}

async function refreshValidation() {
  const result = await fetchJson("/api/paths/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output_folder: state.settings.output_folder }),
  });
  state.validation.baseIsoExists = result.base_iso_exists;
  state.validation.outputFolderExists = result.output_folder_exists;
  state.validation.outputFolder = result.output_folder;
  renderValidationStatus();
  if (state.activeTab === "randomizer_settings") {
    renderActiveTab();
  }
}

function renderValidationStatus() {
  const el = document.getElementById("validation-status");
  const issues = [];
  if (!state.validation.baseIsoExists) {
    issues.push("Missing base ISO.");
  }
  if (!state.validation.outputFolderExists) {
    issues.push("Output folder does not exist.");
  }
  if (!issues.length) {
    el.textContent = "All checks passed.";
    el.style.color = "#2f7d64";
  } else {
    el.textContent = issues.join(" ");
    el.style.color = "#a03a2a";
  }

  const randomizeButton = document.getElementById("randomize");
  randomizeButton.disabled = issues.length > 0;
}

async function generateSeed() {
  const result = await fetchJson("/api/seed", { method: "POST" });
  state.settings.seed = result.seed;
  saveSettings();
  renderActiveTab();
}

async function startRandomize() {
  const status = document.getElementById("run-status");
  const trace = document.getElementById("run-traceback");
  status.textContent = "Queued...";
  trace.textContent = "";
  if (!state.settings.seed) {
    const result = await fetchJson("/api/seed", { method: "POST" });
    state.settings.seed = result.seed;
    await saveSettings();
  }
  const payload = {
    seed: state.settings.seed,
    options: state.settings,
  };
  try {
    const result = await fetchJson("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.lastJobId = result.job_id;
    status.textContent = `Running... (${result.job_id.slice(0, 8)})`;
    await pollJob(result.job_id, status);
    await refreshRecentRuns();
  } catch (err) {
    status.textContent = "Failed to start.";
  }
}

async function pollJob(jobId, statusEl) {
  const trace = document.getElementById("run-traceback");
  let done = false;
  while (!done) {
    const job = await fetchJson(`/api/jobs/${jobId}`);
    if (job.status === "complete") {
      statusEl.textContent = `Complete. Seed: ${job.seed}`;
      trace.textContent = "";
      done = true;
      return;
    }
    if (job.status === "failed") {
      statusEl.textContent = `Failed: ${job.error} (${jobId.slice(0, 8)})`;
      trace.textContent = job.traceback || "";
      done = true;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function updateProgressionLocations() {
  const result = await fetchJson("/api/progression_locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.settings),
  });
  const progressionSection = document.querySelector('[data-section-id="progression_locations"] .section-title');
  if (progressionSection) {
    progressionSection.textContent = `Progression Locations: Where Should Progress Items Be Placed? (Selected: ${result.count} Locations Available)`;
  }
}

function setOptionDescription(text) {
  const el = document.getElementById("option-description");
  if (!text) {
    el.textContent = "Hover an option to see details.";
    return;
  }
  el.innerHTML = text;
}

function coerceInputValue(option, input) {
  if (option.type === "bool") {
    return input.checked;
  }
  if (option.type === "int") {
    const value = Number(input.value);
    if (Number.isNaN(value)) {
      return option.minimum ?? 0;
    }
    return value;
  }
  return input.value;
}

function labelText(optionName) {
  const overrides = {
    clean_iso_path: "Vanilla Wind Waker ISO",
    output_folder: "Randomized Output Folder",
    seed: "Random Seed (optional)",
    custom_player_model: "Model",
    custom_color_preset: "Color Preset",
    player_in_casual_clothes: "Casual Clothes",
    disable_custom_player_voice: "No Custom Voice",
    disable_custom_player_items: "No Custom Items",
  };
  return overrides[optionName] || optionName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function applyOptionRules() {
  const options = state.settings;

  if (!options.progression_dungeons) {
    options.required_bosses = false;
  }
  const requiredBossesInput = document.getElementById("required_bosses");
  if (requiredBossesInput) {
    requiredBossesInput.disabled = !options.progression_dungeons;
    requiredBossesInput.checked = options.required_bosses;
  }

  const numRequired = document.getElementById("num_required_bosses");
  if (numRequired) {
    numRequired.disabled = !options.required_bosses;
  }
  if (options.num_location_hints === 0) {
    options.prioritize_remote_hints = false;
  }
  const prioritizeRemote = document.getElementById("prioritize_remote_hints");
  if (prioritizeRemote) {
    prioritizeRemote.disabled = options.num_location_hints === 0;
    prioritizeRemote.checked = options.prioritize_remote_hints;
  }

  const dungeonRandom = options.randomize_dungeon_entrances || options.randomize_miniboss_entrances || options.randomize_boss_entrances;
  const nonDungeonRandom = options.randomize_secret_cave_entrances || options.randomize_secret_cave_inner_entrances || options.randomize_fairy_fountain_entrances;
  if (!(dungeonRandom && nonDungeonRandom)) {
    options.mix_entrances = "Separate Dungeons From Caves & Fountains";
  }
  const mixEntrances = document.getElementById("mix_entrances");
  if (mixEntrances) {
    mixEntrances.disabled = !(dungeonRandom && nonDungeonRandom);
    mixEntrances.value = options.mix_entrances;
  }

  const filtered = [];
  if (options.sword_mode === "Swordless") {
    filtered.push("Hurricane Spin");
    filtered.push("Progressive Sword", "Progressive Sword", "Progressive Sword");
  } else if (options.sword_mode === "No Starting Sword") {
    filtered.push("Progressive Sword", "Progressive Sword", "Progressive Sword");
  }

  const inventory = state.schema.inventory.inventory_items.slice();
  for (const item of filtered) {
    options.starting_gear = options.starting_gear.filter((value) => value !== item);
  }

  options.randomized_gear = subtractInventory(inventory, options.starting_gear);
  options.randomized_gear.sort();
  options.starting_gear.sort();

  if (state.activeTab === "starting_items") {
    renderActiveTab();
  }
}

function subtractInventory(inventory, selected) {
  const counts = {};
  for (const item of selected) {
    counts[item] = (counts[item] || 0) + 1;
  }
  const result = [];
  for (const item of inventory) {
    if (counts[item]) {
      counts[item] -= 1;
    } else {
      result.push(item);
    }
  }
  return result;
}

async function saveSettings() {
  await fetchJson("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.settings),
  });
  updatePermalink();
  updateProgressionLocations();
  refreshValidation();
}

async function refreshRecentRuns() {
  const outputsEl = document.getElementById("recent-outputs");
  const logsEl = document.getElementById("recent-logs");
  const downloadButton = document.getElementById("download-latest");
  outputsEl.innerHTML = "";
  logsEl.innerHTML = "";

  try {
    const result = await fetchJson("/api/runs/recent");
    renderRecentList(outputsEl, result.outputs, true);
    renderRecentList(logsEl, result.logs);
    if (result.outputs.length) {
      downloadButton.disabled = false;
      downloadButton.dataset.latest = result.outputs[0].name;
    } else {
      downloadButton.disabled = true;
      delete downloadButton.dataset.latest;
    }
  } catch (err) {
    outputsEl.innerHTML = "<li class='muted'>Failed to load.</li>";
    logsEl.innerHTML = "<li class='muted'>Failed to load.</li>";
    downloadButton.disabled = true;
    delete downloadButton.dataset.latest;
  }
}

function renderRecentList(container, items, highlightLatest = false) {
  if (!items.length) {
    container.innerHTML = "<li class='muted'>None yet.</li>";
    return;
  }
  items.forEach((item, index) => {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.className = "recent-link";
    link.href = `/api/files/output/${encodeURIComponent(item.name)}`;
    link.textContent = item.name;
    link.target = "_blank";

    const meta = document.createElement("div");
    meta.className = "recent-meta";
    meta.textContent = `${formatSize(item.size_bytes)} · ${formatTime(item.modified)}`;

    if (highlightLatest && index === 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Latest";
      link.appendChild(badge);
    }

    li.appendChild(link);
    li.appendChild(meta);
    container.appendChild(li);
  });
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString();
}

function downloadLatestOutput() {
  const downloadButton = document.getElementById("download-latest");
  const latest = downloadButton.dataset.latest;
  if (!latest) {
    return;
  }
  const url = `/api/files/output/${encodeURIComponent(latest)}`;
  window.open(url, "_blank");
}

async function updatePermalink() {
  const result = await fetchJson("/api/permalink/encode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seed: state.settings.seed,
      options: state.settings,
    }),
  });
  document.getElementById("permalink").value = result.permalink;
  document.getElementById("permalink-warning").textContent = "";
}

async function decodePermalink() {
  const input = document.getElementById("permalink");
  const warning = document.getElementById("permalink-warning");
  warning.textContent = "";
  try {
    const result = await fetchJson("/api/permalink/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permalink: input.value,
        options: state.settings,
      }),
    });
    if (result.warning) {
      warning.textContent = result.warning;
    }
    state.settings.seed = result.seed;
    state.settings = { ...state.settings, ...result.options };
    await saveSettings();
    renderActiveTab();
  } catch (err) {
    warning.textContent = "Invalid permalink.";
  }
}

async function resetDefaults() {
  const defaults = await fetchJson("/api/settings/defaults");
  state.settings = defaults;
  await saveSettings();
  renderActiveTab();
}

async function copyOutputPath() {
  const outputFolder = state.settings.output_folder || "data/local/output";
  await navigator.clipboard.writeText(outputFolder);
  const status = document.getElementById("run-status");
  status.textContent = `Output path copied: ${outputFolder}`;
}

async function loadCustomModels() {
  const result = await fetchJson("/api/custom_models");
  state.customModelList = result.models.filter((model) => model !== "Link");
}

init().catch(() => {
  const content = document.getElementById("tab-content");
  content.innerHTML = "<p>Failed to load schema or settings.</p>";
});
