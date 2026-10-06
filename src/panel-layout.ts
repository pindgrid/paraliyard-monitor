// Fixed chrome around a chart panel's plot area, in px. The panel heights in
// src/styles.css are plot + chrome; tests subtract these to check the plots.

// Top padding for the panel title (panel-config's layout.padding.top).
export const CHROME_TOP_PX = 18;
// The legend under a panel with more than one series.
export const CHROME_LEGEND_PX = 32;
// The x time labels, on the bottom panel of a stack only.
export const CHROME_TIME_LABELS_PX = 24;
