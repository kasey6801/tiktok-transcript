// Writing transcripts to disk via chrome.downloads.
//
// This exists because the File System Access folder picker does not work from
// an extension: showDirectoryPicker() throws AbortError without ever drawing a
// dialog (WICG/file-system-access#314, crbug 40240444). Downloads cannot target
// an arbitrary folder, only a subfolder of Downloads, but it works reliably and
// needs no permission prompt beyond the downloads permission already held.
//
// Note the data: URL. This runs in the service worker, where
// URL.createObjectURL does not exist, so a blob URL is not an option.

import { toMd, toSrt, safeName } from "./formats.js";
import { log } from "./log.js";

const FOLDER = "TikTok Transcripts";

function dataUrl(text, mime) {
  // encodeURIComponent keeps this correct for non-ASCII transcripts, which
  // matters because the model is multilingual.
  return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
}

function renderFormats(record, formats) {
  const base = `tiktok_${safeName(record.meta?.creator ?? "unknown")}_${record.id}`;
  const files = [];
  if (formats.json) files.push([`${base}.json`, JSON.stringify(record, null, 2), "application/json"]);
  if (formats.md) files.push([`${base}.md`, toMd(record), "text/markdown"]);
  if (formats.srt) files.push([`${base}.srt`, toSrt(record), "application/x-subrip"]);
  return files;
}

// Returns {written: [...names]}. Never throws: a download problem must not be
// able to fail a transcript that is already safely in chrome.storage.
export async function writeTranscriptToDownloads(record, formats) {
  const written = [];
  for (const [name, contents, mime] of renderFormats(record, formats)) {
    try {
      await chrome.downloads.download({
        url: dataUrl(contents, mime),
        filename: `${FOLDER}/${name}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      written.push(name);
    } catch (err) {
      log("downloads", `failed writing ${name}: ${err?.message ?? err}`);
    }
  }
  if (written.length) log("downloads", `wrote ${written.join(", ")} to ${FOLDER}/`);
  return { written };
}
