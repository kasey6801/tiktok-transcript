// Popup UI (ports static/app.js). Pure view layer: sends commands to the
// background worker and re-attaches to the running job via storage.onChanged
// instead of polling. Safe to close at any moment; jobs continue elsewhere.

import { MSG, STATE, TERMINAL_STATES } from "./lib/messages.js";
import { toTxt, toMd, toSrt, safeName } from "./lib/formats.js";
import {
  isTikTokUrl,
  classifyTikTokUrl,
  pageKindLabel,
  activeVideoUrlFromTab,
} from "./lib/tiktok.js";
import { log } from "./lib/log.js";
import { getSettings, setSettings } from "./lib/store.js";

const urlInput = document.getElementById("url-input");
const goBtn = document.getElementById("go-btn");
const tabBtn = document.getElementById("tab-btn");
const clearBtn = document.getElementById("clear-btn");
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const resultMeta = document.getElementById("result-meta");
const transcriptBox = document.getElementById("transcript");
const tsToggle = document.getElementById("ts-toggle");
const copyBtn = document.getElementById("copy-btn");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const restoreBtn = document.getElementById("restore-btn");
const themeToggle = document.getElementById("theme-toggle");
const modelSelect = document.getElementById("model-select");
const askWhere = document.getElementById("ask-where");
const deviceNote = document.getElementById("device-note");
const folderNote = document.getElementById("folder-note");
const openOptionsBtn = document.getElementById("open-options-btn");

let currentData = null;

goBtn.addEventListener("click", () => submit(urlInput.value.trim(), null));
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(urlInput.value.trim(), null); });
tabBtn.addEventListener("click", useCurrentTab);
clearBtn.addEventListener("click", clearAll);
tsToggle.addEventListener("change", renderTranscript);
copyBtn.addEventListener("click", () => copyText(copyBtn, currentText()));
clearHistoryBtn.addEventListener("click", () => twoClickConfirm(clearHistoryBtn, "Clear list", clearHistory));
restoreBtn.addEventListener("click", restoreHistory);
themeToggle.addEventListener("click", toggleTheme);
openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("dl-txt").addEventListener("click", () => download("txt"));
document.getElementById("dl-md").addEventListener("click", () => download("md"));
document.getElementById("dl-srt").addEventListener("click", () => download("srt"));

syncThemeLabel();
init();

async function init() {
  await loadSettings();
  loadHistory();
  const job = await send({ type: MSG.JOB_CURRENT });
  if (job && !TERMINAL_STATES.has(job.state)) {
    goBtn.disabled = true;
    showStatus(job.detail + "...", "working");
  } else if (job?.state === STATE.DONE && job.transcriptId) {
    loadTranscript(job.transcriptId);
  }
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.job) onJobUpdate(changes.job.newValue);
  });
  probeDevice();
  refreshSaveNote();
}

// Say where transcripts are going, so "saving to disk" is not something the
// user has to open the settings page to confirm.
async function refreshSaveNote() {
  const settings = await getSettings();
  folderNote.classList.remove("hidden");
  folderNote.textContent = settings.saveToDownloads
    ? `Also saving to disk: ${settings.downloadSubfolder}/`
    : "Saved in this browser only. Turn on saving to disk in settings.";
}

function send(message) {
  return chrome.runtime.sendMessage({ target: "background", ...message });
}

async function submit(url, activeTab) {
  if (!url) return;
  goBtn.disabled = true;
  showStatus("Starting...", "working");
  const res = await send({ type: MSG.TRANSCRIBE_START, url, activeTab }).catch(() => null);
  if (!res || res.error) {
    goBtn.disabled = false;
    showStatus(res?.error ?? "Could not start the transcription.", "error");
  }
}

async function useCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !isTikTokUrl(tab.url)) {
    showStatus("The current tab is not a TikTok page.", "error");
    return;
  }

  const kind = classifyTikTokUrl(tab.url);
  if (kind === "video" || kind === "short") {
    urlInput.value = tab.url;
    submit(tab.url, { id: tab.id, url: tab.url });
    return;
  }

  // Feed and profile pages keep their own URL in the address bar while a video
  // plays, so the tab URL is the wrong question. Ask the page instead.
  showStatus("Finding the video that is playing...", "working");
  const found = await activeVideoUrlFromTab(tab.id);
  log("tab", `page kind "${kind}" -> ${found ? `strategy "${found.strategy}", id ${found.id}` : "no video found"}`);

  if (!found?.url) {
    const detail = found?.id
      ? "Found a video on this page but could not work out which account it belongs to. Open the video directly and try again."
      : `This is ${pageKindLabel(kind)}. Play a video here, or open the video directly, then try again.`;
    showStatus(detail, "error");
    return;
  }

  // Show what was picked before submitting, so an unexpected match is visible
  // rather than silently transcribed.
  urlInput.value = found.url;
  submit(found.url, null);
}

function onJobUpdate(job) {
  if (!job) return;
  if (job.state === STATE.DONE && job.transcriptId) {
    goBtn.disabled = false;
    hideStatus();
    loadTranscript(job.transcriptId);
    loadHistory();
  } else if (TERMINAL_STATES.has(job.state)) {
    goBtn.disabled = false;
    showStatus(job.detail, job.state === STATE.ERROR ? "error" : "notice");
  } else {
    showStatus(job.detail + "...", "working");
  }
}

async function loadTranscript(id) {
  const data = await send({ type: MSG.TRANSCRIPT_GET, id }).catch(() => null);
  if (!data || data.error) return;
  currentData = data;
  resultMeta.textContent = "";
  const link = document.createElement("a");
  link.href = data.meta.source_url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `@${data.meta.creator}`;
  resultMeta.appendChild(link);
  const parts = [];
  if (data.meta.upload_date) parts.push(data.meta.upload_date);
  if (data.language) parts.push(`language: ${data.language}`);
  parts.push(`engine: ${data.engine}`);
  const span = document.createElement("span");
  span.textContent = " " + parts.join(" | ");
  resultMeta.appendChild(span);
  renderTranscript();
  resultBox.classList.remove("hidden");
}

function renderTranscript() {
  if (!currentData) return;
  transcriptBox.textContent = "";
  for (const seg of currentData.segments) {
    const line = document.createElement("div");
    line.className = "seg";
    line.textContent = tsToggle.checked ? `[${fmtTime(seg.start)}] ${seg.text}` : seg.text;
    transcriptBox.appendChild(line);
  }
}

function currentText() {
  if (!currentData) return "";
  return currentData.segments
    .map((s) => (tsToggle.checked ? `[${fmtTime(s.start)}] ${s.text}` : s.text))
    .join("\n");
}

async function download(fmt, data = currentData) {
  if (!data) return;
  const renderers = { txt: toTxt, md: toMd, srt: toSrt };
  const types = { txt: "text/plain", md: "text/markdown", srt: "application/x-subrip" };
  const blob = new Blob([renderers[fmt](data)], { type: types[fmt] });
  const url = URL.createObjectURL(blob);
  const settings = await getSettingsFromUi();
  chrome.downloads.download(
    {
      url,
      filename: `TikTok Transcripts/tiktok_${safeName(data.meta.creator)}_${data.id}.${fmt}`,
      saveAs: settings.askWhere,
    },
    () => setTimeout(() => URL.revokeObjectURL(url), 30000)
  );
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch (err) {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = "Copy"), 1500);
}

function clearAll() {
  currentData = null;
  urlInput.value = "";
  hideStatus();
  resultBox.classList.add("hidden");
  transcriptBox.textContent = "";
  resultMeta.textContent = "";
  goBtn.disabled = false;
  urlInput.focus();
}

async function clearHistory() {
  await send({ type: MSG.HISTORY_CLEAR_ALL }).catch(() => {});
  clearAll();
  loadHistory();
}

async function restoreHistory() {
  await send({ type: MSG.HISTORY_RESTORE_ALL }).catch(() => {});
  loadHistory();
}

async function loadHistory() {
  const res = await send({ type: MSG.HISTORY_LIST }).catch(() => null);
  if (!res || res.error) return;
  historyList.textContent = "";
  historyEmpty.classList.toggle("hidden", res.entries.length > 0);
  restoreBtn.classList.toggle("hidden", !res.hasCleared);
  for (const entry of res.entries) {
    historyList.appendChild(buildHistoryEntry(entry));
  }
}

function buildHistoryEntry(entry) {
  const li = document.createElement("li");
  const details = document.createElement("details");
  details.className = "history-entry";

  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "history-label";
  label.textContent = `@${entry.creator}${entry.caption ? ` ${entry.caption}` : ""}`;
  const when = document.createElement("span");
  when.className = "muted";
  when.textContent = entry.saved_at.replace("T", " ").slice(0, 16);
  summary.appendChild(label);
  summary.appendChild(when);

  const body = document.createElement("div");
  body.className = "history-body";
  details.appendChild(summary);
  details.appendChild(body);
  details.addEventListener("toggle", () => {
    if (details.open && !details.dataset.loaded) {
      details.dataset.loaded = "1";
      fillHistoryBody(entry.id, body);
    }
  });
  li.appendChild(details);
  return li;
}

async function fillHistoryBody(id, body) {
  body.textContent = "Loading...";
  const data = await send({ type: MSG.TRANSCRIPT_GET, id }).catch(() => null);
  if (!data || data.error) {
    body.textContent = "Could not load this transcript.";
    return;
  }
  body.textContent = "";

  const actions = document.createElement("div");
  actions.className = "downloads";
  const copy = document.createElement("button");
  copy.textContent = "Copy";
  copy.addEventListener("click", () =>
    copyText(copy, data.segments.map((s) => s.text).join("\n"))
  );
  actions.appendChild(copy);
  for (const fmt of ["txt", "md", "srt"]) {
    const btn = document.createElement("button");
    btn.className = fmt === "md" ? "dl dl-md" : "dl";
    btn.textContent = `.${fmt}`;
    btn.addEventListener("click", () => download(fmt, data));
    actions.appendChild(btn);
  }
  const clear = document.createElement("button");
  clear.textContent = "Clear";
  clear.className = "history-clear";
  clear.addEventListener("click", () =>
    twoClickConfirm(clear, "Clear", async () => {
      await send({ type: MSG.TRANSCRIPT_CLEAR, id }).catch(() => {});
      loadHistory();
    })
  );
  actions.appendChild(clear);
  body.appendChild(actions);

  const text = document.createElement("div");
  text.className = "history-text";
  for (const seg of data.segments) {
    const line = document.createElement("div");
    line.className = "seg";
    line.textContent = seg.text;
    text.appendChild(line);
  }
  body.appendChild(text);
}

// window.confirm is unreliable in popups; two clicks within 3 s instead.
function twoClickConfirm(button, label, action) {
  if (button.dataset.confirming) {
    delete button.dataset.confirming;
    button.classList.remove("confirming");
    button.textContent = label;
    action();
    return;
  }
  button.dataset.confirming = "1";
  button.classList.add("confirming");
  button.textContent = "Really?";
  setTimeout(() => {
    delete button.dataset.confirming;
    button.classList.remove("confirming");
    button.textContent = label;
  }, 3000);
}

async function loadSettings() {
  // Defaults come from lib/store.js rather than being restated here. Keeping a
  // second copy meant the popup offered "base" while the background actually
  // ran "small".
  const settings = await getSettings();
  modelSelect.value = settings.model;
  askWhere.checked = settings.askWhere;
  modelSelect.addEventListener("change", persistSettings);
  askWhere.addEventListener("change", persistSettings);
}

async function persistSettings() {
  // setSettings merges. Writing the settings object wholesale here used to wipe
  // folderFormats, saveToDownloads and downloadSubfolder every time the model
  // was changed.
  await setSettings({ model: modelSelect.value, askWhere: askWhere.checked });
}

async function getSettingsFromUi() {
  return { model: modelSelect.value, askWhere: askWhere.checked };
}

async function probeDevice() {
  try {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    deviceNote.textContent = adapter
      ? "Whisper runs on this device via WebGPU."
      : "Whisper runs on this device via WebAssembly (slower).";
  } catch (err) {
    deviceNote.textContent = "Whisper runs on this device via WebAssembly.";
  }
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function showStatus(text, kind) {
  statusBox.textContent = text;
  statusBox.className = `status ${kind}`;
}

function hideStatus() {
  statusBox.className = "status hidden";
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
