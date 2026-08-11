// Runs synchronously in <head> so the theme is set before first paint.
// MV3 CSP forbids inline scripts, so this lives in its own file.
(function () {
  var stored = null;
  try { stored = localStorage.getItem("theme"); } catch (e) {}
  var dark = stored ? stored === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
})();
