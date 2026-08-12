// Options page, opened in a tab rather than as a popup.
//
// There is deliberately no folder picker here. showDirectoryPicker() is simply
// not exposed to extension pages, so a "choose any folder" control could never
// work (WICG/file-system-access#314, crbug 40240444). Chrome only lets an
// extension write inside the browser's own download directory, so location is
// controlled by two things instead: Chrome's download folder setting for the
// parent, and the subfolder below.

import * as store from "./lib/store.js";
import { normaliseSubfolder } from "./lib/dlwrite.js";
import { readLog, clearLog, formatLog, log } from "./lib/log.js";

const folderStatus = document.getElementById("folder-status");
const savePath = document.getElementById("save-path");
const subfolderInput = document.getElementById("subfolder-input");
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

document.getElementById("view-log-btn").addEventListener("click", viewLog);
document.getElementById("copy-log-btn").addEventListener("click", copyLog);
document.getElementById("export-log-btn").addEventListener("click", exportLog);
document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await clearLog();
  logView.textContent = "";
  logView.classList.add("hidden");
  logStatus.textContent = "Log cleared.";
});
document.getElementById("subfolder-save-btn").addEventListener("click", saveSubfolder);
subfolderInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSubfolder(); });
document.getElementById("open-dl-settings-btn").addEventListener("click", openDownloadSettings);

saveDownloads.addEventListener("change", async () => {
  await store.setSettings({ saveToDownloads: saveDownloads.checked });
  await refreshSaving();
  show(folderStatus, saveDownloads.checked
    ? "New transcripts will be saved to disk as well."
    : "Stopped saving to disk. Transcripts are kept in this browser.");
});

writeAllDownloadsBtn.addEventListener("click", async () => {
  writeAllDownloadsBtn.disabled = true;
  show(folderStatus, "Writing...");
  try {
    const count = await store.writeAllToDownloads();
    show(folderStatus, `Wrote ${count} transcript${count === 1 ? "" : "s"} to disk.`);
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
  subfolderInput.value = settings.downloadSubfolder;
  await refreshSaving();
}

async function refreshSaving() {
  const settings = await store.getSettings();
  const folder = normaliseSubfolder(settings.downloadSubfolder);
  savePath.textContent = settings.saveToDownloads
    ? `<Chrome download folder>/${folder}/`
    : "nowhere on disk yet";
}

async function saveSubfolder() {
  // Normalise before storing so what is shown is what will actually be used;
  // Chrome rejects absolute paths and "..", and a silent rejection at download
  // time would be far harder to understand than a corrected value here.
  const cleaned = normaliseSubfolder(subfolderInput.value);
  subfolderInput.value = cleaned;
  await store.setSettings({ downloadSubfolder: cleaned });
  await refreshSaving();
  log("downloads", `subfolder set to "${cleaned}"`);
  show(folderStatus, `Saving to the "${cleaned}" subfolder.`);
}

function openDownloadSettings() {
  // A page cannot navigate itself to chrome://settings, but the tabs API can.
  chrome.tabs.create({ url: "chrome://settings/downloads" }).catch(() => {
    show(folderStatus, "Open chrome://settings/downloads manually to change the download folder.");
  });
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
