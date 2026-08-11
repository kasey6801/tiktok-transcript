// Diagnostic log (ports the file logging added to app.py). An extension has no
// terminal and Chrome discards service-worker console output once the worker is
// torn down, so without this a failed job leaves no trace at all. That is the
// same hole that made the desktop app's failures hard to diagnose.
//
// Entries live in chrome.storage.local, capped so the log cannot grow forever.

const KEY = "log";
const MAX_ENTRIES = 500;

// Writes are serialised per context so concurrent calls cannot clobber each
// other's read-modify-write. Separate contexts (service worker, offscreen
// document) still race in principle; losing a diagnostic line is acceptable,
// breaking a transcription over one is not, so every failure here is swallowed.
let chain = Promise.resolve();

export function log(ctx, message) {
  const entry = { t: new Date().toISOString(), ctx, msg: String(message) };
  chain = chain.then(() => append(entry)).catch(() => {});
  return chain;
}

async function append(entry) {
  const got = await chrome.storage.local.get(KEY);
  const entries = [...(got[KEY] ?? []), entry];
  await chrome.storage.local.set({ [KEY]: entries.slice(-MAX_ENTRIES) });
}

export async function readLog() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] ?? [];
}

export async function clearLog() {
  await chrome.storage.local.set({ [KEY]: [] });
}

export function formatLog(entries) {
  if (!entries.length) return "No log entries yet.\n";
  return entries.map((e) => `${e.t} [${e.ctx}] ${e.msg}`).join("\n") + "\n";
}
