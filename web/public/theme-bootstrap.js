(() => {
  let saved = null;
  try {
    saved = localStorage.getItem("herdr-web:theme");
  } catch {
    // Storage may be unavailable in private contexts.
  }
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved === "light" || saved === "dark" ? saved : systemDark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#111212" : "#f7f8f6",
  );
})();
