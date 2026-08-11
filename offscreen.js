// Offscreen document: owns the long-running Whisper job so it survives popup
// close and service-worker termination. Fetches the video itself (extension
// pages get cookie-included, CORS-exempt fetch under our host permissions),
// decodes the audio track to 16 kHz mono, and hands it to the worker.

import { MSG, STATE } from "./lib/messages.js";
import { log as writeLog } from "./lib/log.js";

let worker = null;

function log(jobId, message) {
  writeLog("offscreen", `job ${jobId}: ${message}`);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return;
  if (message.type === MSG.ASR_RUN) {
    runAsr(message).catch((err) => report(MSG.ASR_ERROR, {
      jobId: message.jobId,
      code: "unexpected",
      detail: String(err?.message ?? err),
    }));
  }
});

async function runAsr({ jobId, mediaCandidates, model, modelSize }) {
  // 1+2. Download and decode. Candidates are tried in order because TikTok's
  // metadata does not reliably say which renditions carry audio: an h265 stream
  // can advertise audio and deliver none. The first one that decodes to real
  // samples wins, so "no audio track" is only reported once every candidate has
  // actually been checked.
  const audio = await firstDecodableAudio(jobId, mediaCandidates ?? []);
  if (audio.error) {
    report(MSG.ASR_ERROR, { jobId, code: audio.error, detail: audio.detail });
    return;
  }

  // 3. Transcribe in the worker (kept alive across jobs so the model stays warm).
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL("transcribe.worker.js"), { type: "module" });
    worker.addEventListener("message", onWorkerMessage);
    worker.addEventListener("error", (e) => {
      report(MSG.ASR_ERROR, { jobId: currentJobId, code: "unexpected", detail: e.message });
    });
  }
  currentJobId = jobId;
  const samples = audio.samples;
  worker.postMessage(
    { type: "run", jobId, audio: samples, model, modelSize, durationSec: samples.length / 16000 },
    [samples.buffer]
  );
}

// Walk the candidate media URLs until one yields decodable audio. Returns
// {samples} on success, or {error, detail} describing why none worked.
async function firstDecodableAudio(jobId, candidates) {
  if (!candidates.length) {
    return { error: "no_audio", detail: "no media URL in the page data" };
  }
  let downloaded = 0;
  let lastDetail = "";

  for (const [index, url] of candidates.entries()) {
    log(jobId, `media candidate ${index + 1}/${candidates.length}: fetching`);
    let buffer;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = await res.arrayBuffer();
    } catch (err) {
      lastDetail = String(err?.message ?? err);
      log(jobId, `media candidate ${index + 1}: download failed (${lastDetail})`);
      continue;
    }
    downloaded += 1;

    try {
      const samples = await decodeToMono16k(buffer);
      if (samples.length) {
        log(jobId, `media candidate ${index + 1}: decoded ${Math.round(samples.length / 16000)}s of audio`);
        return { samples };
      }
      lastDetail = "empty audio";
    } catch (err) {
      lastDetail = String(err?.message ?? err);
    }
    // Almost always a video-only rendition; try the next.
    log(jobId, `media candidate ${index + 1}: no audio stream (${lastDetail})`);
  }

  // Nothing downloaded at all is a network problem, not a silent video.
  if (!downloaded) return { error: "download_failed", detail: lastDetail };
  return { error: "no_audio", detail: lastDetail };
}

let currentJobId = null;

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === "log") {
    // Workers have no chrome APIs, so the worker relays its lines through here.
    writeLog("whisper", msg.detail);
  } else if (msg.type === "progress") {
    report(MSG.ASR_PROGRESS, { jobId: msg.jobId, state: msg.state, detail: msg.detail });
  } else if (msg.type === "done") {
    report(MSG.ASR_DONE, { jobId: msg.jobId, segments: msg.segments, language: msg.language });
  } else if (msg.type === "error") {
    report(MSG.ASR_ERROR, { jobId: msg.jobId, code: msg.code, detail: msg.detail });
  }
}

function report(type, payload) {
  chrome.runtime.sendMessage({ target: "background", type, ...payload }).catch(() => {});
}

async function decodeToMono16k(arrayBuffer) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const channels = decoded.numberOfChannels;
    if (!channels) throw new Error("no audio channels");
    if (channels === 1) return decoded.getChannelData(0).slice();
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }
    return mono;
  } finally {
    ctx.close().catch(() => {});
  }
}
