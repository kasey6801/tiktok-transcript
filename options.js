// Options page. Exists because showDirectoryPicker() closes the popup that
// calls it, which loses the result; a full page in a tab survives the picker.
// It is also the only place a user gesture is reliably available for
// re-granting folder permission, which a service worker can never do.

import * as fsstore from "./lib/fsstore.js";
import * as store from "./lib/store.js";
import { readLog, clearLog, formatLog, log } from "./lib/log.js";

const folderName = document.getElementById("folder-name");
const folderState = document.getElementById("folder-state");
const folderStatus = document.getElementById("folder-status");
const chooseBtn = document.getElementById("choose-folder-btn");
const regrantBtn = document.getElementById("regrant-btn");
const writeAllBtn = document.getElementById("write-all-btn");
const forgetBtn = document.getElementById("forget-folder-btn");
const logStatus = document.getElementById("log-status");
const themeToggle = document.getElementById("theme-toggle");

const FORMAT_BOXES = {
  json: document.getElementById("fmt-json"),
  md: document.getElementById("fmt-md"),
  srt: document.getElementById("fmt-srt"),
};

chooseBtn.addEventListener("click", chooseFolder);
regrantBtn.addEventListener("click", regrant);
writeAllBtn.addEventListener("click", writeAll);
forgetBtn.addEventListener("click", forgetFolder);
document.getElementById("export-log-btn").addEventListener("click", exportLog);
document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await clearLog();
  logStatus.textContent = "Log cleared.";
});
themeToggle.addEventListener("click", toggleTheme);
for (const [key, box] of Object.entries(FORMAT_BOXES)) {
  box.addEventListener("change", () => persistFormats(key));
}

syncThemeLabel();
init();

async function init() {
  const settings = await store.getSettings();
  for (const [key, box] of Object.entries(FORMAT_BOXES)) {
    box.checked = settings.folderFormats[key] !== false;
  }
  await refreshFolder();
}

async function refreshFolder() {
  const handle = await fsstore.getHandle();
  const state = await fsstore.permissionState(handle);

  folderName.textContent = handle?.name ?? "not set";
  regrantBtn.classList.toggle("hidden", state !== "prompt" && state !== "denied");
  writeAllBtn.classList.toggle("hidden", state !== "granted");
  forgetBtn.classList.toggle("hidden", !handle);

  const explain = {
    none: "No folder chosen. Transcripts are kept in this browser only.",
    granted: "Connected. New transcripts are written here automatically.",
    prompt: "Chrome needs you to confirm access again. Nothing has been lost; transcripts are still in this browser.",
    denied: "Access was denied. Reconnect to start writing files again.",
  };
  folderState.textContent = explain[state] ?? "";
}

async function chooseFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite", id: "tiktok-transcripts" });
  } catch (err) {
    return; // The user cancelled the picker.
  }
  await fsstore.setHandle(handle);
  log("folder", `folder set to "${handle.name}"`);
  await store.clearFolderWarning();
  await refreshFolder();
  show(folderStatus, "Folder saved. Use the button above to write your existing history into it.");
}

async function regrant() {
  const state = await fsstore.requestPermission();
  if (state === "granted") await store.clearFolderWarning();
  await refreshFolder();
  show(
    folderStatus,
    state === "granted" ? "Reconnected." : "Chrome did not grant access to that folder."
  );
}

async function writeAll() {
  writeAllBtn.disabled = true;
  show(folderStatus, "Writing...");
  try {
    const count = await store.writeAllToFolder();
    show(folderStatus, `Wrote ${count} transcript${count === 1 ? "" : "s"} to the folder.`);
  } catch (err) {
    show(folderStatus, `Could not write everything: ${err?.message ?? err}`);
  }
  writeAllBtn.disabled = false;
}

async function forgetFolder() {
  await fsstore.clearHandle();
  await store.clearFolderWarning();
  log("folder", "folder cleared");
  await refreshFolder();
  show(folderStatus, "Stopped using a folder. Transcripts stay in this browser.");
}

async function persistFormats(changedKey) {
  const folderFormats = {};
  for (const [key, box] of Object.entries(FORMAT_BOXES)) folderFormats[key] = box.checked;
  if (!Object.values(folderFormats).some(Boolean)) {
    // All-off would silently stop writing files; keep the one just touched on.
    folderFormats[changedKey] = true;
    FORMAT_BOXES[changedKey].checked = true;
    show(folderStatus, "At least one format has to stay selected.");
  }
  await store.setSettings({ folderFormats });
}

async function exportLog() {
  const entries = await readLog();
  const blob = new Blob([formatLog(entries)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: "tiktok-transcript-log.txt", saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 30000)
  );
  logStatus.textContent = `Exported ${entries.length} entries.`;
}

function show(node, text) {
  node.textContent = text;
  node.classList.remove("hidden");
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") !== "dark";
  if (dark) root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (err) {}
  syncThemeLabel();
}

function syncThemeLabel() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  themeToggle.textContent = dark ? "☀️ Light" : "🌙 Dark";
}
