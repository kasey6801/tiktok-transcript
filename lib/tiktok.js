// The only module that talks to TikTok (ports engine/fetch.py). All page-shape
// knowledge lives here, so when TikTok changes its markup the fix is contained.
// Extraction ladder: A) read the open tab's DOM, B) background fetch of the
// page HTML, C) hidden tab that renders the page for real.

export class TikTokError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid_url | unavailable | photo_post | parse_failed
  }
}

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

export function isTikTokUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && TIKTOK_HOSTS.has(parsed.hostname.toLowerCase());
}

// Resolve short links (vm./vt.) to the canonical page; returns {url, html}.
async function fetchPage(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  const html = await res.text();
  return { url: res.url, html };
}

// Pull the hydration JSON out of raw HTML (rung B).
export function parseHydrationFromHtml(html) {
  for (const id of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
    const match = html.match(
      new RegExp(`<script[^>]*id="${id}"[^>]*>(.*?)</script>`, "s")
    );
    if (match) {
      try {
        return { id, data: JSON.parse(match[1]) };
      } catch (err) {
        continue;
      }
    }
  }
  return null;
}

// Interpret the hydration JSON into {meta, captionTrack, playAddr}.
export function interpretHydration(parsed, originalUrl, canonicalUrl) {
  let item = null;
  let statusCode = 0;
  if (parsed.id === "__UNIVERSAL_DATA_FOR_REHYDRATION__") {
    const scope = parsed.data?.["__DEFAULT_SCOPE__"]?.["webapp.video-detail"];
    statusCode = scope?.statusCode ?? 0;
    item = scope?.itemInfo?.itemStruct ?? null;
  } else {
    // Legacy SIGI_STATE shape: ItemModule keyed by video id.
    const module = parsed.data?.ItemModule;
    if (module) item = Object.values(module)[0] ?? null;
  }

  if (!item || (statusCode && statusCode !== 0)) {
    throw new TikTokError(
      "unavailable",
      "TikTok would not provide this video (private, deleted, or blocked)."
    );
  }
  if (item.imagePost) {
    throw new TikTokError(
      "photo_post",
      "This looks like a photo or slideshow post. There is no video audio to transcribe."
    );
  }

  const meta = {
    video_id: String(item.id ?? "unknown"),
    creator: item.author?.uniqueId ?? item.author?.nickname ?? String(item.author ?? "unknown"),
    caption: (item.desc ?? "").trim(),
    upload_date: item.createTime
      ? new Date(Number(item.createTime) * 1000).toISOString().slice(0, 10)
      : "",
    duration: item.video?.duration ?? null,
    source_url: canonicalUrl,
    original_url: originalUrl,
  };

  const captionTrack = pickCaptionTrack(item);

  return { meta, captionTrack, mediaCandidates: pickMediaCandidates(item) };
}

// TikTok's bytevc1 (h265) renditions are video-only in the delivered file even
// when the metadata implies otherwise, so a single best-quality pick can hand
// back a silent download and make a video full of speech look soundless. Return
// every usable URL, cheapest-and-most-likely-first, and let the caller probe the
// actual bytes. Mirrors _AUDIO_SELECTORS in engine/fetch.py.
export function pickMediaCandidates(item) {
  const video = item?.video ?? {};
  const h264 = [];
  const other = [];

  for (const info of video.bitrateInfo ?? []) {
    const url = info?.PlayAddr?.UrlList?.[0];
    if (!url) continue;
    const codec = String(info.CodecType ?? "").toLowerCase();
    // h264/avc renditions reliably carry audio; bytevc1/h265 often do not.
    if (codec.includes("h264") || codec.includes("avc")) h264.push(url);
    else other.push(url);
  }

  // playAddr is TikTok's own default playback stream and is the likeliest to
  // have audio, so it leads regardless of what bitrateInfo advertises.
  const ordered = [video.playAddr, ...h264, video.downloadAddr, ...other];
  return [...new Set(ordered.filter(Boolean))];
}

function pickCaptionTrack(item) {
  const infos = item.video?.subtitleInfos ?? [];
  const now = Math.floor(Date.now() / 1000);
  const usable = infos.filter((s) => {
    const format = (s.Format ?? "").toLowerCase();
    if (format !== "webvtt" && format !== "vtt") return false;
    if (!s.Url) return false;
    if (s.UrlExpire && Number(s.UrlExpire) < now) return false;
    return true;
  });
  if (!usable.length) return null;
  const asr = usable.find((s) => (s.Source ?? "").toUpperCase() === "ASR");
  const track = asr ?? usable[0];
  return {
    url: track.Url,
    lang: (track.LanguageCodeName ?? "").split("-")[0] || null,
  };
}

// Rung A/C helper: read the hydration script tag from a live tab's DOM.
async function extractFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      for (const id of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]) {
        const el = document.getElementById(id);
        if (el?.textContent) return { id, text: el.textContent };
      }
      return null;
    },
  });
  const value = results?.[0]?.result;
  if (!value) return null;
  try {
    return { id: value.id, data: JSON.parse(value.text) };
  } catch (err) {
    return null;
  }
}

// Rung C: render the page in a hidden tab, read the DOM, close the tab.
async function extractViaHiddenTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, 20000);
    return await extractFromTab(tab.id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out loading the TikTok page."));
    }, timeoutMs);
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Give hydration a moment after "complete".
        setTimeout(resolve, 800);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// The full extraction ladder. activeTab: {id, url} when the popup captured a
// current-tab request, so rung A can read that tab's DOM directly.
export async function extract(originalUrl, activeTab) {
  if (!isTikTokUrl(originalUrl)) {
    throw new TikTokError(
      "invalid_url",
      "That does not look like a TikTok URL. Paste a link from tiktok.com or vm.tiktok.com."
    );
  }

  // Rung A: the requested video is already open in the active tab.
  if (activeTab?.id != null && activeTab.url === originalUrl) {
    const parsed = await extractFromTab(activeTab.id).catch(() => null);
    if (parsed) return interpretHydration(parsed, originalUrl, activeTab.url);
  }

  // Rung B: plain fetch of the page HTML.
  let canonicalUrl = originalUrl;
  try {
    const page = await fetchPage(originalUrl);
    canonicalUrl = page.url;
    const parsed = parseHydrationFromHtml(page.html);
    if (parsed) return interpretHydration(parsed, originalUrl, canonicalUrl);
  } catch (err) {
    if (err instanceof TikTokError) throw err;
    // fall through to rung C
  }

  // Rung C: bot-wall or login-wall HTML; render for real in a hidden tab.
  const parsed = await extractViaHiddenTab(canonicalUrl).catch(() => null);
  if (parsed) return interpretHydration(parsed, originalUrl, canonicalUrl);

  throw new TikTokError(
    "parse_failed",
    "Could not read this TikTok page. TikTok may have changed its page format; check for an updated extension."
  );
}

// Fetch a caption track's WebVTT text. Failure is never fatal to a job.
export async function fetchVtt(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`caption fetch ${res.status}`);
  return res.text();
}
