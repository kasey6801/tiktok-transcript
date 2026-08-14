// The only module that talks to TikTok (ports engine/fetch.py). All page-shape
// knowledge lives here, so when TikTok changes its markup the fix is contained.
// Extraction ladder: A) read the open tab's DOM, B) background fetch of the
// page HTML, C) hidden tab that renders the page for real.

import { log } from "./log.js";

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

// Hosts this extension is willing to fetch from or open. Mirrors the manifest's
// host_permissions. Caption and media URLs arrive from the page's own hydration
// JSON, and redirects can land anywhere, so without this check a compromised or
// redirecting TikTok page could steer credentialed requests and tab navigations
// to an origin of its choosing. Verified against a real video page: media and
// captions are served from *.tiktok.com and *.tiktokcdn-us.com.
const RESOURCE_HOST_SUFFIXES = [
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
];

export function isAllowedResourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return RESOURCE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const VIDEO_PATH = /^\/@[\w.-]+\/video\/(\d+)/;
const PHOTO_PATH = /^\/@[\w.-]+\/photo\/(\d+)/;
const BARE_VIDEO_PATH = /^\/(?:v|video)\/(\d+)/;
const SHORT_PATH = /^\/t\/[\w-]+/;
const FEED_PATHS = new Set(["/", "/foryou", "/following", "/explore", "/friends", "/live"]);
const PROFILE_PATH = /^\/@[\w.-]+\/?$/;

// The host check alone is not enough: a feed URL like /following is a perfectly
// valid tiktok.com address that contains no video, and treating it as one is
// what made "Use current tab" fail with a misleading error.
export function classifyTikTokUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return "other";
  }
  if (!TIKTOK_HOSTS.has(parsed.hostname.toLowerCase())) return "other";

  // Short links resolve to a video, but only after a redirect.
  if (parsed.hostname.toLowerCase().startsWith("vm.")
    || parsed.hostname.toLowerCase().startsWith("vt.")
    || SHORT_PATH.test(parsed.pathname)) return "short";

  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (VIDEO_PATH.test(parsed.pathname) || BARE_VIDEO_PATH.test(parsed.pathname)) return "video";
  if (PHOTO_PATH.test(parsed.pathname)) return "photo";
  if (FEED_PATHS.has(path)) return "feed";
  if (PROFILE_PATH.test(parsed.pathname)) return "profile";
  return "other";
}

export function videoIdFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const match = pathname.match(VIDEO_PATH) ?? pathname.match(BARE_VIDEO_PATH);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

// Human-readable name for a page that is not a single video, used to say what
// actually went wrong instead of blaming the video.
export function pageKindLabel(kind) {
  return {
    feed: "a TikTok feed page",
    profile: "a TikTok profile page",
    photo: "a photo or slideshow post",
    other: "not a TikTok video page",
  }[kind] ?? "not a TikTok video page";
}

// Resolve short links (vm./vt.) to the canonical page; returns {url, html}.
async function fetchPage(url) {
  if (!isAllowedResourceUrl(url)) {
    throw new TikTokError("invalid_url", `Refusing to fetch ${hostOf(url)}: not a TikTok host.`);
  }
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  // Short links redirect, and a redirect can land anywhere. Where it landed is
  // what later steps treat as canonical, so it is checked as well as the input.
  if (!isAllowedResourceUrl(res.url)) {
    throw new TikTokError("invalid_url", `That link redirected to ${hostOf(res.url)}, which is not TikTok.`);
  }
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

  // These are two different failures and used to share one message. A non-zero
  // statusCode is TikTok refusing a video it knows about; a missing item just
  // means this page is not a single video, which is what a feed or profile URL
  // produces. Reporting the latter as "private, deleted, or blocked" blames the
  // video for the caller having asked about the wrong page.
  if (statusCode && statusCode !== 0) {
    throw new TikTokError(
      "unavailable",
      "TikTok would not provide this video (private, deleted, or blocked)."
    );
  }
  if (!item) {
    throw new TikTokError(
      "wrong_page",
      "That page is not a single TikTok video. Open the video itself, or play it in the feed and use Use current tab."
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
  const ordered = [...new Set([video.playAddr, ...h264, video.downloadAddr, ...other].filter(Boolean))];
  // These URLs come from the page, so they are only as trustworthy as the page.
  // Anything off a TikTok host is dropped rather than fetched with credentials.
  // Dropping is logged: if TikTok ever moves media to a CDN family outside the
  // allowlist, that has to be visible rather than looking like a video with no
  // audio.
  const allowed = ordered.filter(isAllowedResourceUrl);
  for (const url of ordered) {
    if (!allowed.includes(url)) log("security", `dropped media URL on non-TikTok host ${hostOf(url)}`);
  }
  return allowed;
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

// Ask the live page which video is actually playing. Neither the tab URL nor the
// hydration JSON can answer this on a feed: the address bar keeps the feed URL,
// and the hydration payload is server-rendered at load time so it knows nothing
// about scroll position. Only the DOM knows.
export async function activeVideoUrlFromTab(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func: pickActiveVideo });
  } catch (err) {
    return null;
  }
  return results?.[0]?.result ?? null;
}

// Runs inside the page, so it must be completely self-contained: it is
// serialised across the boundary and cannot close over anything in this module.
// Returns {url, author, id, strategy} or null. `strategy` is logged so a future
// TikTok redesign shows up as a named strategy going quiet rather than as a
// silent regression.
export function pickActiveVideo() {
  const LINK = /\/@([\w.-]+)\/video\/(\d+)/;
  const AWEME = /\b(\d{15,25})\b/;

  const videos = Array.from(document.querySelectorAll("video"));
  if (!videos.length) return null;

  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };

  // Genuinely playing beats merely occupying space; among equals, most visible.
  const playing = videos.filter((v) => !v.paused && !v.ended && v.currentTime > 0);
  const pool = playing.length ? playing : videos;
  const video = pool.reduce((best, v) => (visibleArea(v) > visibleArea(best) ? v : best), pool[0]);
  if (!video) return null;
  if (!playing.length && visibleArea(video) === 0) return null;

  const build = (author, id, strategy) => ({
    url: `https://www.tiktok.com/@${author}/video/${id}`,
    author,
    id,
    strategy,
  });

  // Strategy A: an anchor to the canonical video URL within the item. Walk
  // outwards from the video and stop at the first ancestor that yields exactly
  // one video id. Seeing several means the scope has widened to neighbouring
  // feed items, and guessing between them could transcribe the wrong video, so
  // that is treated as a failure rather than a coin toss.
  let node = video.parentElement;
  for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
    const found = new Map();
    for (const a of node.querySelectorAll("a[href*='/video/']")) {
      const m = (a.getAttribute("href") || "").match(LINK);
      if (m) found.set(m[2], m[1]);
    }
    if (found.size === 1) {
      const [id, author] = [...found.entries()][0];
      return build(author, id, "anchor");
    }
    if (found.size > 1) break;
  }

  // Strategy B: an aweme id on the element itself or an ancestor (TikTok has
  // historically put it in ids such as xgwrapper-0-<id>), paired with the
  // author taken from a profile link in the same subtree.
  node = video;
  for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
    let id = null;
    for (const attr of node.attributes ?? []) {
      const m = String(attr.value).match(AWEME);
      if (m) { id = m[1]; break; }
    }
    if (!id) continue;
    let scope = node;
    for (let up = 0; scope && up < 6; up++, scope = scope.parentElement) {
      const link = scope.querySelector("a[href*='/@']");
      const author = link?.getAttribute("href")?.match(/\/@([\w.-]+)/)?.[1];
      if (author) return build(author, id, "attribute");
    }
    return { url: null, author: null, id, strategy: "attribute-id-only" };
  }

  return null;
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
  // This opens a real tab, so a redirect that left TikTok must not be followed
  // into one.
  if (!isAllowedResourceUrl(url)) {
    throw new TikTokError("invalid_url", `Refusing to open ${hostOf(url)}: not a TikTok host.`);
  }
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
  if (!isAllowedResourceUrl(url)) {
    throw new Error(`caption fetch refused: ${hostOf(url)} is not a TikTok host`);
  }
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`caption fetch ${res.status}`);
  return res.text();
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return "an unreadable URL";
  }
}
