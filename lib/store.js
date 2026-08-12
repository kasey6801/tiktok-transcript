// Ports engine/store.py onto chrome.storage.local. One key per transcript
// (prefix "t:"), same JSON shape as the desktop app. Soft-clear sets a
// cleared flag instead of deleting, so nothing is ever lost by one click.

import * as fsstore from "./fsstore.js";
import { writeTranscriptToDownloads } from "./dlwrite.js";
import { log } from "./log.js";

const PREFIX = "t:";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safe(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}

function timestampId(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export async function save(meta, segments, engineUsed, language) {
  const now = new Date();
  const id = `${timestampId(now)}_${safe(meta.video_id)}`;
  const record = {
    id,
    saved_at: now.toISOString().slice(0, 19),
    engine: engineUsed,
    language: language ?? null,
    meta,
    segments,
    cleared: false,
  };
  await chrome.storage.local.set({ [PREFIX + id]: record });

  // chrome.storage stays the source of truth for the history list; the folder is
  // the durable copy. Writing it must never be able to lose a transcript, so a
  // folder that is unset or not currently permitted just flags itself for the UI
  // and leaves the record safely in storage.
  // Belt and braces: the record is already stored, so nothing about the folder
  // is allowed to throw past this point and turn a saved transcript into a
  // failed job.
  try {
    const settings = await getSettings();
    const result = await fsstore.writeTranscript(record, settings.folderFormats);
    await setFolderStatus(result.skipped === "prompt" || result.skipped === "denied");
    // Independent of the folder: Downloads is the path that works even when the
    // folder picker is unavailable, which it is in an extension today.
    if (settings.saveToDownloads) {
      await writeTranscriptToDownloads(record, settings.folderFormats);
    }
  } catch (err) {
    log("folder", `write failed for ${id}, transcript kept in this browser: ${err?.message ?? err}`);
  }

  return id;
}

// Surfaced in the popup so a folder that silently stopped working is visible
// rather than being discovered later as missing files.
async function setFolderStatus(needsPermission) {
  const got = await chrome.storage.local.get("folderNeedsPermission");
  if ((got.folderNeedsPermission ?? false) === needsPermission) return;
  await chrome.storage.local.set({ folderNeedsPermission: needsPermission });
}

export async function folderNeedsPermission() {
  const got = await chrome.storage.local.get("folderNeedsPermission");
  return got.folderNeedsPermission ?? false;
}

export async function clearFolderWarning() {
  await setFolderStatus(false);
}

// Write everything already in chrome.storage out to a newly chosen folder, so
// switching to folder storage does not leave the existing history behind.
export async function writeAllToFolder() {
  const settings = await getSettings();
  const records = await allRecords();
  let written = 0;
  for (const record of records) {
    if (record.cleared) continue;
    const result = await fsstore.writeTranscript(record, settings.folderFormats);
    if (result.written?.length) written += 1;
  }
  return written;
}

// Same idea for the Downloads path, so switching it on does not leave the
// existing history behind.
export async function writeAllToDownloads() {
  const settings = await getSettings();
  const records = await allRecords();
  let written = 0;
  for (const record of records) {
    if (record.cleared) continue;
    const result = await writeTranscriptToDownloads(record, settings.folderFormats);
    if (result.written?.length) written += 1;
  }
  return written;
}

export async function load(id) {
  if (!SAFE_ID.test(id)) throw new Error("unknown transcript");
  const got = await chrome.storage.local.get(PREFIX + id);
  const record = got[PREFIX + id];
  if (!record) throw new Error("unknown transcript");
  return record;
}

async function allRecords() {
  const everything = await chrome.storage.local.get(null);
  return Object.entries(everything)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([, record]) => record);
}

export async function listRecent(limit = 50) {
  const records = await allRecords();
  return records
    .filter((r) => !r.cleared)
    .sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      creator: r.meta?.creator ?? "unknown",
      caption: (r.meta?.caption ?? "").slice(0, 80),
      saved_at: r.saved_at,
      engine: r.engine,
      language: r.language,
    }));
}

export async function hasCleared() {
  const records = await allRecords();
  return records.some((r) => r.cleared);
}

export async function clearOne(id) {
  const record = await load(id);
  record.cleared = true;
  await chrome.storage.local.set({ [PREFIX + id]: record });
}

export async function clearAll() {
  const records = await allRecords();
  const updates = {};
  let count = 0;
  for (const r of records) {
    if (!r.cleared) {
      r.cleared = true;
      updates[PREFIX + r.id] = r;
      count += 1;
    }
  }
  if (count) await chrome.storage.local.set(updates);
  return count;
}

export async function restoreAll() {
  const records = await allRecords();
  const updates = {};
  let count = 0;
  for (const r of records) {
    if (r.cleared) {
      r.cleared = false;
      updates[PREFIX + r.id] = r;
      count += 1;
    }
  }
  if (count) await chrome.storage.local.set(updates);
  return count;
}

export async function getSettings() {
  const got = await chrome.storage.local.get("settings");
  const stored = got.settings ?? {};
  return {
    // Matches the desktop app, which is hardcoded to Whisper small.
    model: "onnx-community/whisper-small",
    askWhere: false,
    saveToDownloads: false,
    ...stored,
    // Merged separately so adding a format later does not leave it undefined
    // for anyone who already saved settings.
    folderFormats: { json: true, md: true, srt: true, ...(stored.folderFormats ?? {}) },
  };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
