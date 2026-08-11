// Folder storage via the File System Access API: the extension's answer to the
// desktop app's configurable transcripts folder. Pick a directory once and every
// transcript is written there, so the history outlives the extension itself
// rather than living only in chrome.storage.
//
// The directory handle goes in IndexedDB because handles are structured-
// cloneable objects; chrome.storage serialises to JSON and cannot hold one.

import { toMd, toSrt, safeName } from "./formats.js";
import { log } from "./log.js";

const DB_NAME = "tiktok-transcript";
const DB_VERSION = 1;
const STORE = "handles";
const HANDLE_KEY = "transcriptsDir";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      })
  );
}

export async function getHandle() {
  try {
    return (await withStore("readonly", (s) => s.get(HANDLE_KEY))) ?? null;
  } catch (err) {
    return null;
  }
}

export async function setHandle(handle) {
  await withStore("readwrite", (s) => s.put(handle, HANDLE_KEY));
}

export async function clearHandle() {
  await withStore("readwrite", (s) => s.delete(HANDLE_KEY));
}

// "granted" | "prompt" | "denied" | "none" (no folder chosen yet).
// Chrome can downgrade a stored handle back to "prompt" after a restart, and
// requestPermission() needs a user gesture, which a service worker never has.
// So callers must treat anything other than "granted" as "cannot write now"
// rather than as an error.
export async function permissionState(handle) {
  const dir = handle ?? (await getHandle());
  if (!dir) return "none";
  try {
    return await dir.queryPermission({ mode: "readwrite" });
  } catch (err) {
    return "denied";
  }
}

// Only ever call from a page with a live user gesture (the options page).
export async function requestPermission() {
  const dir = await getHandle();
  if (!dir) return "none";
  try {
    return await dir.requestPermission({ mode: "readwrite" });
  } catch (err) {
    return "denied";
  }
}

function renderFormats(record, formats) {
  const base = `tiktok_${safeName(record.meta?.creator ?? "unknown")}_${record.id}`;
  const files = [];
  if (formats.json) {
    files.push([`${base}.json`, JSON.stringify(record, null, 2)]);
  }
  if (formats.md) files.push([`${base}.md`, toMd(record)]);
  if (formats.srt) files.push([`${base}.srt`, toSrt(record)]);
  return files;
}

// Write one transcript in every enabled format. Returns a result the caller can
// surface without having to know about permissions:
//   {written: [...names]}                  at least one file landed
//   {skipped: "none"|"prompt"|"denied"}    nothing written, and why
// A failure on one format never aborts the others, and never aborts the save
// that the chrome.storage record already completed.
export async function writeTranscript(record, formats) {
  const dir = await getHandle();
  if (!dir) return { skipped: "none" };

  const state = await permissionState(dir);
  if (state !== "granted") {
    log("folder", `cannot write ${record.id}: permission is "${state}"`);
    return { skipped: state };
  }

  const written = [];
  for (const [name, contents] of renderFormats(record, formats)) {
    try {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable();
      await stream.write(contents);
      await stream.close();
      written.push(name);
    } catch (err) {
      log("folder", `failed writing ${name}: ${err?.message ?? err}`);
    }
  }
  if (written.length) log("folder", `wrote ${written.join(", ")}`);
  return { written };
}
