// Runs before the page paints (a classic script, not a module, so it is not deferred).
// It only APPLIES the saved look; choosing one is lib/theme.js. Kept tiny on purpose.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("delta-look") || "{}");
    var root = document.documentElement;
    if (["soft", "vibrant", "ocean"].indexOf(saved.design) >= 0) root.setAttribute("data-design", saved.design);
    if (saved.mode === "light" || saved.mode === "dark") root.setAttribute("data-theme", saved.mode);
  } catch (e) { /* storage blocked: the defaults are fine */ }
})();
