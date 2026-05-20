/**
 * Returns Chart.js-compatible colors derived from the current CSS theme variables.
 * Call this inside onMount or after DOM is available.
 */
export function getChartTheme() {
  const style = getComputedStyle(document.documentElement);

  const get = (prop: string) => style.getPropertyValue(prop).trim();

  return {
    brand: get("--brand"),
    brandLight: get("--brand-light"),
    brandTint: get("--brand-soft"),
    green: get("--good"),
    red: get("--bad"),
    yellow: get("--warn"),
    blue: "#2563eb",
    text: get("--text"),
    textMuted: get("--text-muted"),
    border: get("--border"),
    surface: get("--bg-card"),
    gridColor: get("--border"),
    fontFamily: get("--font-sans"),
  };
}

/**
 * Common Chart.js defaults for consistent theming.
 */
export function getChartDefaults() {
  const theme = getChartTheme();

  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: theme.textMuted,
          font: { family: theme.fontFamily, size: 12 },
          usePointStyle: true,
          pointStyle: "circle",
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: theme.surface,
        titleColor: theme.text,
        bodyColor: theme.textMuted,
        borderColor: theme.border,
        borderWidth: 1,
        cornerRadius: 8,
        padding: { x: 12, y: 8 },
        titleFont: { family: theme.fontFamily, weight: "600" as const, size: 13 },
        bodyFont: { family: theme.fontFamily, size: 12 },
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
        grid: { color: theme.gridColor, lineWidth: 0.5 },
        border: { display: false },
      },
      y: {
        ticks: { color: theme.textMuted, font: { family: theme.fontFamily, size: 11 } },
        grid: { color: theme.gridColor, lineWidth: 0.5 },
        border: { display: false },
      },
    },
    elements: {
      bar: { borderRadius: 6 },
      line: { tension: 0.3, borderWidth: 2.5 },
      point: { radius: 3, hoverRadius: 5 },
    },
  };
}
