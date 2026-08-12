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
const logView = document.getElementById("log-view");
const saveDownloads = document.getElementById("save-downloads");
const writeAllDownloadsBtn = document.getElementById("write-all-downloads-btn");
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
document.getElementById("view-log-btn").addEventListener("click", viewLog);
document.getElementById("copy-log-btn").addEventListener("click", copyLog);
document.getElementById("export-log-btn").addEventListener("click", exportLog);
document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await clearLog();
  logView.textContent = "";
  logView.classList.add("hidden");
  logStatus.textContent = "Log cleared.";
});
saveDownloads.addEventListener("change", async () => {
  await store.setSettings({ saveToDownloads: saveDownloads.checked });
  show(folderStatus, saveDownloads.checked
    ? "New transcripts will also be saved to Downloads/TikTok Transcripts."
    : "Stopped saving to Downloads.");
});
writeAllDownloadsBtn.addEventListener("click", async () => {
  writeAllDownloadsBtn.disabled = true;
  show(folderStatus, "Writing to Downloads...");
  try {
    const count = await store.writeAllToDownloads();
    show(folderStatus, `Wrote ${count} transcript${count === 1 ? "" : "s"} to Downloads/TikTok Transcripts.`);
  } catch (err) {
    show(folderStatus, `Could not write everything: ${err?.message ?? err}`);
  }
  writeAllDownloadsBtn.disabled = false;
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
  saveDownloads.checked = settings.saveToDownloads === true;
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
  if (typeof window.showDirectoryPicker !== "function") {
    show(folderStatus, "This Chrome build does not offer a folder picker. Use \"Also save to Downloads\" below instead.");
    log("folder", "showDirectoryPicker is not available in this context");
    return;
  }

  let handle;
  const startedAt = Date.now();
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite", id: "tiktok-transcripts" });
  } catch (err) {
    // A real cancellation and the known extension failure both surface as
    // AbortError, but the failure returns instantly because no dialog is ever
    // drawn. Anything under a second was not a human deciding.
    const instant = Date.now() - startedAt < 1000;
    if (err?.name === "AbortError" && !instant) {
      log("folder", "folder picker cancelled by the user");
      return;
    }
    const detail = err?.name === "AbortError"
      ? "Chrome refused to open the folder picker. This is a known Chrome limitation for extensions (the picker never appears). Use \"Also save to Downloads\" below, which does not depend on it."
      : `Could not open the folder picker: ${err?.name ?? "error"} ${err?.message ?? ""}`.trim();
    show(folderStatus, detail);
    log("folder", `folder picker failed: ${err?.name}: ${err?.message}`);
    return;
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

// Read the log here rather than making a round trip through a downloaded file.
async function viewLog() {
  const entries = await readLog();
  logView.textContent = formatLog(entries);
  logView.classList.remove("hidden");
  logStatus.textContent = `Showing ${entries.length} entries, newest last.`;
  logView.scrollTop = logView.scrollHeight;
}

async function copyLog() {
  const entries = await readLog();
  try {
    await navigator.clipboard.writeText(formatLog(entries));
    logStatus.textContent = `Copied ${entries.length} entries.`;
  } catch (err) {
    logStatus.textContent = "Could not copy. Use View log and select the text.";
  }
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
