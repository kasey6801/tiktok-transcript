// Ports engine/formats.py: renders a saved transcript into download formats.

export function toTxt(data) {
  return data.segments.map((s) => s.text).join("\n") + "\n";
}

export function toMd(data) {
  const meta = data.meta;
  const creator = meta.creator ?? "unknown";
  const lines = [
    `# TikTok Transcript: @${creator}`,
    "",
    `- Source: [TikTok video by @${creator}](${meta.source_url ?? ""})`,
  ];
  if (meta.original_url) lines.push(`- Original URL: ${meta.original_url}`);
  lines.push(
    `- Video caption: ${meta.caption || "(none)"}`,
    `- Uploaded: ${meta.upload_date || "unknown"}`,
    `- Duration: ${durationLabel(meta.duration)}`,
    `- Language: ${data.language || "unknown"}`,
    `- Transcript engine: ${data.engine ?? "unknown"}`,
    `- Saved: ${data.saved_at ?? ""}`,
    "",
    "## Transcript",
    "",
    toTxt(data)
  );
  return lines.join("\n");
}

export function toSrt(data) {
  return data.segments
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`)
    .join("\n");
}

function srtTime(seconds) {
  let millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3600000);
  millis -= hours * 3600000;
  const minutes = Math.floor(millis / 60000);
  millis -= minutes * 60000;
  const secs = Math.floor(millis / 1000);
  millis -= secs * 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
}

export function durationLabel(duration) {
  if (!duration) return "unknown";
  const minutes = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);
  return minutes ? `${minutes}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;
}

export function safeName(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown";
}
