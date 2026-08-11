// Whisper worker (ports engine/transcribe.py). Hosts the transformers.js
// pipeline: model download with progress, WASM or WebGPU inference, timed
// segments out. The pipeline is cached per model+device so repeat jobs skip
// the load entirely.

import { pipeline, env } from "./vendor/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
  env.backends.onnx.wasm.numThreads = 1;
}

let asr = null;
let asrKey = null;

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (msg.type !== "run") return;
  const { jobId, audio, model, modelSize, durationSec } = msg;
  try {
    const device = await pickDevice();
    await loadPipeline(jobId, model, modelSize, device);
    const segments = await transcribe(jobId, audio, durationSec);
    if (!segments.length) {
      post({ type: "error", jobId, code: "no_speech" });
      return;
    }
    post({ type: "done", jobId, segments, language: lastLanguage ?? "auto" });
  } catch (err) {
    const code = asr ? "unexpected" : "model_failed";
    post({ type: "log", detail: `job ${jobId} failed (${code}): ${err?.message ?? err}` });
    post({ type: "error", jobId, code, detail: String(err?.message ?? err) });
  }
});

async function pickDevice() {
  try {
    if (self.navigator?.gpu && (await navigator.gpu.requestAdapter())) return "webgpu";
  } catch (err) { /* fall through */ }
  return "wasm";
}

async function loadPipeline(jobId, model, modelSize, device) {
  const key = `${model}|${device}`;
  if (asr && asrKey === key) {
    post({ type: "log", detail: `reusing warm pipeline ${key}` });
    return;
  }
  post({ type: "log", detail: `loading ${model} on ${device}` });
  asr = null;
  const seen = new Map();
  asr = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype: device === "webgpu"
      ? { encoder_model: "fp16", decoder_model_merged: "q4" }
      : "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.file && p.total) {
        seen.set(p.file, p.progress ?? 0);
        const avg = [...seen.values()].reduce((a, b) => a + b, 0) / seen.size;
        post({
          type: "progress",
          jobId,
          state: "loading_model",
          detail: `Downloading the Whisper model (${modelSize || "one time"}): ${Math.round(avg)}%`,
        });
      }
    },
  });
  asrKey = key;
}

let lastLanguage = null;

// Filler lines Whisper hallucinates on silence/music.
const BOILERPLATE = /^(thank you\.?|thanks for watching\.?|\[music\]|\(music\)|\[applause\]|you\.?|\.+)$/i;

async function transcribe(jobId, audio, durationSec) {
  post({
    type: "progress",
    jobId,
    state: "transcribing",
    detail: `Transcribing ${Math.round(durationSec)}s of audio on this device`,
  });
  const out = await asr(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    task: "transcribe",
  });
  lastLanguage = out?.language ?? null;

  const chunks = out?.chunks ?? [];
  const segments = [];
  for (const chunk of chunks) {
    const text = (chunk.text ?? "").trim();
    if (!text || BOILERPLATE.test(text)) continue;
    const [start, end] = chunk.timestamp ?? [null, null];
    segments.push({
      start: round3(start ?? 0),
      end: round3(end ?? start ?? 0),
      text,
    });
  }
  // A transcript that is only boilerplate across the whole video is no speech.
  return segments;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function post(payload) {
  self.postMessage(payload);
}
