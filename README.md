# TikTok Transcript

A Chrome extension that turns a TikTok video into a text transcript, entirely on your own
machine. It reads TikTok's own caption track when the video has one, and otherwise
transcribes the audio with Whisper running locally in the browser.

No account, no server, no upload. Audio never leaves your device.

## Install

There is no build step. Clone and load the folder directly:

```bash
git clone https://github.com/kasey6801/tiktok-transcript.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the cloned folder

Chrome 124 or newer.

## Use

Open a TikTok video, click the extension icon, then **Use current tab**. Or paste any
`tiktok.com`, `vm.tiktok.com` or `vt.tiktok.com` link into the box.

Transcripts are saved automatically, listed in the popup, and exportable as `.txt`, `.md`
or `.srt`. The job runs in an offscreen document, so it keeps going after you close the
popup.

## Saving to a folder

By default transcripts live in the browser, which means removing the extension removes
them. Open **Transcript folder and diagnostics...** in the popup to pick a folder as well;
every new transcript is then written to disk too.

Each transcript writes one file per selected format, named `tiktok_<creator>_<id>`:

| Format | Contents |
|--------|----------|
| `.json` | Full record, including segment timings and metadata |
| `.md` | Readable transcript with a labeled source link |
| `.srt` | Subtitles with timecodes |

Chrome can withdraw folder access after a restart. If that happens the popup says so and
transcripts keep saving to browser storage, so nothing is lost; reconnect the folder from
the settings page to resume writing files.

## Whisper models

Selectable in the popup. Larger is more accurate and slower, and each is a one-time
download cached by the browser.

| Model | Download | Notes |
|-------|----------|-------|
| tiny | 41 MB | Fastest, weakest |
| base | 77 MB | |
| small | 249 MB | **Default** |
| large-v3-turbo | 1.1–1.6 GB | Most accurate; wants WebGPU |

The popup tells you whether your machine runs Whisper on WebGPU or the slower WebAssembly
path. On WebAssembly, turbo is not practical.

## Privacy

- **Transcription is on-device.** Decoded audio goes straight to a local worker and is
  never sent anywhere.
- Outbound traffic is exactly two things: requests to TikTok for the page, captions and
  video, and a one-time model download from `huggingface.co`.
- TikTok requests use your existing session cookies. That is what lets the extension read
  caption tracks that anonymous tools cannot see, and it means TikTok can associate those
  requests with your account.
- Storage is `chrome.storage.local`, which does not sync to your Google account. The
  diagnostic log stays local and is only written to a file when you export it.

## Diagnostics

The settings page keeps a rolling log of the last 500 events: jobs accepted, state
changes, which media streams were tried and whether they contained audio, folder writes
and model loading. Export it if a transcription fails and the on-screen message does not
explain why.

## Why the `.wasm` file is committed

`vendor/` holds a pinned transformers.js and the onnxruntime-web WebAssembly binary
(about 25 MB). They are in the tree on purpose: it keeps the extension installable with no
build step and no install-time network fetch, which is the whole point of the design.

## Documentation

[`USER_GUIDE.md`](USER_GUIDE.md) covers everything in more depth, including the message
table, troubleshooting, and an architecture section describing the four execution contexts
and the extraction ladder.

## A note on use

This is a personal-use tool for reading transcripts of videos you can already watch. How
you use it against TikTok's terms of service is your responsibility. Reading TikTok's page
data is the one genuinely fragile part of the design, and is deliberately confined to
`lib/tiktok.js` so a TikTok change is a one-file fix.

## License

MIT. See [LICENSE](LICENSE).
