// Ports engine/captions.py: WebVTT to timed segments, merging the rolling
// duplicate lines TikTok's auto-caption VTT often contains.

const TIMING = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
const TAGS = /<[^>]+>/g;

export class CaptionParseError extends Error {}

export function parseVtt(text) {
  const segments = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue; // WEBVTT header, NOTE, STYLE, cue-id-only
    const match = TIMING.exec(lines[timingIdx]);
    if (!match) continue;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const cueText = lines
      .slice(timingIdx + 1)
      .map((l) => l.replace(TAGS, ""))
      .join(" ")
      .trim();
    if (!cueText) continue;
    const last = segments[segments.length - 1];
    if (last && cueText === last.text) {
      last.end = Math.max(last.end, end);
    } else {
      segments.push({ start, end, text: cueText });
    }
  }
  if (!segments.length) {
    throw new CaptionParseError("The caption file contained no usable cues.");
  }
  return segments;
}

function toSeconds(hours, minutes, seconds, millis) {
  return (Number(hours) || 0) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}
