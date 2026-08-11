# TikTok Transcript Extension: User Guide

**Last updated:** 2026-08-10

A Chrome extension that turns a TikTok video link into a text transcript. Everything runs in your browser: it reads TikTok's own captions when the video has them, and otherwise transcribes the audio on your device with Whisper. No account, no server, no data sent anywhere except your requests to TikTok and a one-time speech-model download.

For how it is put together, see [section 11, Architecture](#11-architecture) below.

---

## 1. Install

1. Open `chrome://extensions` in Chrome (version 124 or newer).
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select this `extension` folder.
4. Optional: click the puzzle-piece icon in the toolbar and pin **TikTok Transcript** so its button stays visible.

To update after the code changes, click the reload arrow on the extension's card in `chrome://extensions`.

## 2. Get a transcript

Two ways, both from the toolbar popup:

- **Use current tab.** Open any TikTok video, click the extension icon, click **Use current tab**.
- **Paste a URL.** Paste any TikTok video link (including `vm.tiktok.com` short links) into the box and click **Get transcript**.

The status line walks through the stages: fetching video info, reading captions, or (when the video has no captions) downloading audio, then transcribing. Captioned videos finish in a few seconds. Whisper transcription takes longer and shows progress.

**You can close the popup at any time.** The job keeps running in the background; reopen the popup and it picks up where it was.

## 3. The first Whisper run

The first time a video needs Whisper, the extension downloads the speech model (about 77 MB for the default) and shows the download progress. This happens once per model; afterwards it is cached and works offline. Videos with captions never need the model at all.

## 4. Reading and exporting

- **Timestamps** toggle: prefix each line with its start time, like `[0:12]`.
- **Copy**: copies the transcript as shown (with or without timestamps).
- **Download .txt / .md / .srt**:
  - `.txt` is plain text, best for pasting into AI tools.
  - `.md` includes the creator, caption, date, duration, language, a labeled link to the source video, and the original URL you pasted.
  - `.srt` is a standard subtitle file with timestamps.
- Files land in a `TikTok Transcripts` folder inside your Downloads folder. Turn on **Ask where to save each download** in Settings to get a save dialog instead.

## 5. Recent transcripts

Every transcript saves automatically in the extension's storage.

- Click an entry to expand it in place; click again to collapse. The Copy, download, and Clear buttons sit at the top of each expanded entry.
- **Clear** (per entry) and **Clear list** (everything) are soft: cleared transcripts are hidden, not deleted. Destructive buttons ask for a second click ("Really?") within 3 seconds to confirm.
- **Restore cleared** brings hidden transcripts back. It appears only when something has been cleared.

## 6. Settings

In the popup:

- **Whisper model**: tiny (41 MB, fastest, weakest), base (77 MB), small (249 MB, default), large-v3-turbo (1.1-1.6 GB, most accurate). Changing the model only affects future transcriptions; switching triggers a new one-time download. Turbo is a large download and is slow without WebGPU, so pick it only if you want the accuracy and have checked the device note below.
- **Ask where to save each download**: shows the save dialog instead of using the Downloads folder.
- The note at the bottom tells you whether Whisper runs via WebGPU (faster) or WebAssembly on this machine.
- **Transcript folder and diagnostics...** opens the settings page described next.

## 6a. Transcript folder

Transcripts always live in this browser. Choosing a folder as well means every new transcript is also written to disk, so your history survives removing the extension.

1. Open the popup, click **Transcript folder and diagnostics...**
2. Click **Choose folder...** and pick a directory. Chrome asks once for permission to edit files in it.
3. Optionally click **Write existing history to this folder** to export everything you already have.

Each transcript writes one file per selected format, named `tiktok_<creator>_<id>`:

| Format | Contents |
|--------|----------|
| `.json` | The full record, including timings and metadata |
| `.md` | Readable transcript with a labeled source link |
| `.srt` | Subtitles with timecodes |

All three are on by default; at least one must stay selected.

**If the folder stops working.** Chrome can withdraw access after a restart. When that happens the popup shows "Your transcript folder needs reconnecting", and transcripts are kept in the browser as usual so nothing is lost. Open the settings page and click **Reconnect folder** to resume writing files. **Stop using a folder** goes back to browser-only storage.

## 6b. Diagnostics

The settings page keeps a rolling log of the last 500 events: jobs accepted, each state change, which media streams were tried and whether they contained audio, folder writes, and model loading. **Export log** saves it as a text file. Send or read that if a transcription fails and the on-screen message does not explain why.

## 7. Messages you may see

| Message | Meaning |
|---------|---------|
| That does not look like a TikTok URL | The link is not from tiktok.com or a TikTok short-link domain |
| TikTok would not provide this video | The video is private, deleted, or blocked in your region |
| This looks like a photo or slideshow post | Photo posts have no video audio to transcribe |
| This video has no audio track | The video file genuinely contains no audio stream |
| No speech detected | The audio is music or ambient sound only; nothing was saved |
| A transcription is already running | One job at a time; wait for the current one to finish |
| Could not read this TikTok page | TikTok may have changed its page format; the extension needs an update |

## 8. Privacy

- Transcription happens on your device. Audio never leaves your machine.
- Network traffic consists of: requests to TikTok for the page, captions, and video (using your existing TikTok session), and the one-time model download from huggingface.co.
- Transcripts are stored in this browser profile's extension storage, and additionally in your chosen folder if you set one (see section 6a). Browser storage is deleted when the extension is removed; files written to a folder are not. Extension storage is `chrome.storage.local`, which does not sync to your Google account.
- The diagnostic log stays on this machine and is only written to a file when you export it.

## 9. Troubleshooting

- **Popup looks stuck**: close and reopen it; it re-attaches to the running job.
- **Errors after a Chrome update or TikTok redesign**: check the extension card at `chrome://extensions` for an Errors button, and the **service worker** link there for logs. TikTok page-format changes require updating `lib/tiktok.js`; that is the one fragile piece by design.
- **Whisper is slow**: check the Settings note. If it says WebAssembly, your Chrome or GPU does not expose WebGPU; try the tiny model.
- **Downloads blocked**: Chrome may ask for permission the first time the extension downloads a file; allow it.

## 10. Uninstall

Remove the extension from `chrome://extensions`. This deletes the transcripts held in browser storage and the cached model. Files already written to a transcript folder are untouched and stay on disk.

## 11. Architecture

### The four contexts

The extension is split into four cooperating contexts, each with one job:

```
popup (popup.html/js/css)               UI only; safe to close at any moment
   |  commands via chrome.runtime.sendMessage
   |  live updates via chrome.storage.onChanged
   v
background service worker (background.js)   the coordinator
   |  validates URLs, extracts video info, parses captions,
   |  keeps the job record in chrome.storage.session,
   |  saves transcripts to chrome.storage.local
   v
offscreen document (offscreen.html/js)   the long-job host
   |  downloads the video, decodes its audio track
   |  to 16 kHz mono samples
   v
transcribe.worker.js (Web Worker)        the speech engine
      runs Whisper via transformers.js on WebGPU or WebAssembly
```

This shape exists because of three Chrome platform rules: the popup is destroyed the instant it loses focus, the background service worker is terminated after about 30 seconds of idle, and audio decoding (`decodeAudioData`) only exists in contexts with a document. The offscreen document is the one context that persists, so it owns the long Whisper jobs; that is why you can close the popup mid-transcription and nothing is lost. The job's state lives in `chrome.storage.session`, which survives service-worker restarts, and the popup repaints from it whenever it reopens.

### The engine modules (lib/)

- `lib/tiktok.js` is the only file that talks to TikTok. It validates URLs, then climbs a three-rung ladder to get the video's data: read the JSON already embedded in the open tab's page, fetch the page HTML directly, or render the page in a hidden tab when TikTok serves a bot-check. From that JSON it takes the metadata, the caption-track URL if one exists, and the video file URL. When TikTok changes its page format, this is the one file that needs fixing.
- `lib/vtt.js` converts TikTok's WebVTT caption files into timed segments, merging the duplicated rolling lines they often contain.
- `lib/formats.js` renders segments into the .txt, .md, and .srt export formats.
- `lib/store.js` is the transcript store on `chrome.storage.local`: save, list, load, soft-clear, restore.
- `lib/messages.js` defines the message types and job states shared by all contexts.

### How a job flows

1. You submit a URL. The service worker validates it and writes a job record (`fetching`).
2. `lib/tiktok.js` extracts the video's metadata, caption URL, and video URL.
3. **Captions path:** if a caption track exists, the service worker fetches and parses it (`parsing_captions`), saves the transcript with engine `captions`, and the job is `done` in a few seconds. The worker and model are never involved.
4. **Whisper path:** with no usable captions, the service worker starts the offscreen document, which downloads the video (`downloading_audio`), decodes the audio, and hands the samples to the worker. The worker loads the model (first time: `loading_model` with download progress), transcribes (`transcribing`), and returns timed segments. The service worker saves them with engine `whisper`.
5. Either way the transcript lands in `chrome.storage.local`, the history list updates, and the popup (if open) renders the result.

### Major components and their repositories

| Component | Role here | Repository |
|-----------|-----------|------------|
| Transformers.js (Hugging Face) | Runs the Whisper pipeline in the browser; vendored at version 4.2.0 in `vendor/` | [github.com/huggingface/transformers.js](https://github.com/huggingface/transformers.js) |
| ONNX Runtime Web (Microsoft) | The inference engine underneath Transformers.js; its WebAssembly/WebGPU binary is vendored in `vendor/` | [github.com/microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) |
| Whisper (OpenAI) | The speech-recognition model family this extension runs | [github.com/openai/whisper](https://github.com/openai/whisper) |
| Whisper ONNX conversions (onnx-community) | The actual model weights downloaded on first Whisper use, in browser-ready ONNX form | [huggingface.co/onnx-community/whisper-base](https://huggingface.co/onnx-community/whisper-base) (also [whisper-tiny](https://huggingface.co/onnx-community/whisper-tiny), [whisper-small](https://huggingface.co/onnx-community/whisper-small)) |
| Chrome Extensions platform (Chromium) | Manifest V3, service workers, offscreen documents, storage, downloads | [github.com/chromium/chromium](https://github.com/chromium/chromium) · docs: [developer.chrome.com/docs/extensions](https://developer.chrome.com/docs/extensions) |
| WebVTT (W3C) | The caption file format TikTok serves, parsed by `lib/vtt.js` | [github.com/w3c/webvtt](https://github.com/w3c/webvtt) |

The extraction, parsing, formatting, and storage logic itself is original to this project, ported from the desktop app's Python engine (`engine/` in the project root); the project has no public repository.
