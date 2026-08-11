// Background service worker: job orchestration (ports app.py's _run_job).
// Stateless between events by design; the single active job record lives in
// chrome.storage.session so it survives SW termination, and long Whisper work
// runs in the offscreen document, which outlives both the SW and the popup.

import { MSG, STATE, TERMINAL_STATES } from "./lib/messages.js";
import * as tiktok from "./lib/tiktok.js";
import { parseVtt, CaptionParseError } from "./lib/vtt.js";
import * as store from "./lib/store.js";
import { log } from "./lib/log.js";

const OFFSCREEN_URL = "offscreen.html";

// Download sizes, measured from the repos rather than estimated. Figures are the
// WebAssembly (q8) path; WebGPU pulls an fp16 encoder and is larger, which is why
// turbo is given as a range.
const MODEL_SIZES = {
  "onnx-community/whisper-tiny": "41 MB",
  "onnx-community/whisper-base": "77 MB",
  "onnx-community/whisper-small": "249 MB",
  "onnx-community/whisper-large-v3-turbo": "1.1-1.6 GB",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return false;
  handle(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true; // async sendResponse
});

async function handle(message, sender) {
  switch (message.type) {
    case MSG.TRANSCRIBE_START:
      return startJob(message.url, message.activeTab);
    case MSG.JOB_CURRENT:
      return (await chrome.storage.session.get("job")).job ?? null;
    case MSG.HISTORY_LIST:
      return {
        entries: await store.listRecent(),
        hasCleared: await store.hasCleared(),
      };
    case MSG.TRANSCRIPT_GET:
      return store.load(message.id);
    case MSG.TRANSCRIPT_CLEAR:
      await store.clearOne(message.id);
      return { cleared: message.id };
    case MSG.HISTORY_CLEAR_ALL:
      return { cleared: await store.clearAll() };
    case MSG.HISTORY_RESTORE_ALL:
      return { restored: await store.restoreAll() };
    case MSG.ASR_PROGRESS:
      await setJob(message.jobId, { state: message.state, detail: message.detail });
      return {};
    case MSG.ASR_DONE:
      return finishAsrJob(message);
    case MSG.ASR_ERROR:
      return failAsrJob(message);
    default:
      return { error: `unknown message type: ${message.type}` };
  }
}

async function startJob(url, activeTab) {
  url = (url ?? "").trim();
  if (!tiktok.isTikTokUrl(url)) {
    return {
      error: "That does not look like a TikTok URL. Paste a link from tiktok.com or vm.tiktok.com.",
    };
  }
  const existing = (await chrome.storage.session.get("job")).job;
  if (existing && !TERMINAL_STATES.has(existing.state)) {
    return { error: "A transcription is already running. Wait for it to finish." };
  }

  const jobId = crypto.randomUUID().slice(0, 12);
  log("job", `${jobId} accepted for ${url}`);
  await chrome.storage.session.set({
    job: { jobId, url, state: STATE.QUEUED, detail: "Waiting to start", startedAt: Date.now() },
  });
  runJob(jobId, url, activeTab).catch(async (err) => {
    await setJob(jobId, { state: STATE.ERROR, detail: `Unexpected error: ${err?.message ?? err}` });
  });
  return { jobId };
}

async function runJob(jobId, url, activeTab) {
  await setJob(jobId, { state: STATE.FETCHING, detail: "Fetching video info from TikTok" });

  let extracted;
  try {
    extracted = await tiktok.extract(url, activeTab);
  } catch (err) {
    const detail = err instanceof tiktok.TikTokError
      ? err.message
      : `Could not reach TikTok: ${err?.message ?? err}`;
    await setJob(jobId, { state: STATE.ERROR, detail });
    return;
  }
  const { meta, captionTrack, mediaCandidates } = extracted;
  log("job", `${jobId}: extracted @${meta.creator}, captions=${captionTrack ? "yes" : "no"}, media candidates=${mediaCandidates.length}`);

  // Captions first; failure here is never fatal (mirrors the app).
  if (captionTrack) {
    await setJob(jobId, { state: STATE.PARSING_CAPTIONS, detail: "Reading TikTok's captions" });
    try {
      const vttText = await tiktok.fetchVtt(captionTrack.url);
      const segments = parseVtt(vttText);
      const id = await store.save(meta, segments, "captions", captionTrack.lang);
      await setJob(jobId, { state: STATE.DONE, detail: "Done", transcriptId: id });
      return;
    } catch (err) {
      if (!(err instanceof CaptionParseError) && !(err?.message ?? "").includes("caption fetch")) {
        // Unexpected parse trouble still falls through to Whisper.
      }
    }
  }

  if (!mediaCandidates.length) {
    await setJob(jobId, {
      state: STATE.NO_SPEECH,
      detail: "This video has no audio track, so there is nothing to transcribe. Nothing was saved.",
    });
    return;
  }

  const settings = await store.getSettings();
  await setJob(jobId, {
    state: STATE.DOWNLOADING_AUDIO,
    detail: "No usable captions; downloading audio",
    meta, // stash so the ASR completion can save without re-extracting
  });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: MSG.ASR_RUN,
    jobId,
    mediaCandidates,
    model: settings.model,
    modelSize: MODEL_SIZES[settings.model] ?? "",
  });
}

async function finishAsrJob({ jobId, segments, language }) {
  const job = (await chrome.storage.session.get("job")).job;
  if (!job || job.jobId !== jobId || !job.meta) return {};
  const id = await store.save(job.meta, segments, "whisper", language);
  await setJob(jobId, { state: STATE.DONE, detail: "Done", transcriptId: id });
  return {};
}

async function failAsrJob({ jobId, code, detail }) {
  const messages = {
    no_audio: "This video has no audio track, so there is nothing to transcribe. Nothing was saved.",
    no_speech: "No speech detected in this video (music or ambient sound only). Nothing was saved.",
    download_failed: "The video audio could not be downloaded from TikTok.",
    model_failed: "The Whisper model could not be loaded. Check your connection and try again.",
  };
  const state = code === "no_audio" || code === "no_speech" ? STATE.NO_SPEECH : STATE.ERROR;
  await setJob(jobId, {
    state,
    detail: messages[code] ?? `Unexpected error: ${detail ?? code}`,
  });
  return {};
}

async function setJob(jobId, patch) {
  const current = (await chrome.storage.session.get("job")).job;
  if (!current || current.jobId !== jobId) return;
  await chrome.storage.session.set({ job: { ...current, ...patch } });
  // One line per state change, so a failed job is reconstructable from the log
  // alone without reproducing it (mirrors _set_job in app.py).
  if (patch.state) log("job", `${jobId} -> ${patch.state}: ${patch.detail ?? ""}`);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS", "BLOBS"],
    justification: "Decode video audio and run on-device Whisper speech recognition.",
  });
}
