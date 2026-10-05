import { createChart, type ChartHandle } from "./charts";
import { buildOverviewSpecs, pickTarget, type LegendEntry, type OverviewChart } from "./overview-data";
import type { MetricsResponse } from "./types";

export interface OverviewOptions {
  // Opens the history view for one (service, metric).
  open(service: string, metric: string): void;
}

export interface Overview {
  update(data: MetricsResponse | null): void;
}

interface Part {
  list: HTMLUListElement;
  handle: ChartHandle;
}

function setEntry(button: HTMLButtonElement, entry: LegendEntry): void {
  button.textContent = entry.text;
  button.dataset.service = entry.target.service;
  button.dataset.metric = entry.target.metric;
}

// One focusable button per target. Updated in place while the entry count is
// unchanged, so keyboard focus survives a refresh.
function renderLegend(doc: Document, list: HTMLUListElement, entries: LegendEntry[]): void {
  const buttons = [...list.querySelectorAll<HTMLButtonElement>("button[data-service]")];
  if (buttons.length === entries.length) {
    entries.forEach((entry, i) => setEntry(buttons[i], entry));
    return;
  }
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = doc.createElement("li");
      const button = doc.createElement("button");
      button.type = "button";
      setEntry(button, entry);
      item.appendChild(button);
      return item;
    }),
  );
}

// Six chart figures created once; update() only feeds new data to the charts.
// Uses textContent only, never innerHTML.
export function createOverview(host: HTMLElement, doc: Document, { open }: OverviewOptions): Overview {
  let charts: OverviewChart[] = buildOverviewSpecs(null);

  const parts: Part[] = charts.map((chart, i) => {
    const figure = doc.createElement("figure");
    figure.className = "chart";
    figure.dataset.chart = chart.id;
    const caption = doc.createElement("figcaption");
    caption.textContent = chart.title;
    const frame = doc.createElement("div");
    frame.className = "chart-canvas";
    const canvas = doc.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", chart.title);
    frame.appendChild(canvas);
    const list = doc.createElement("ul");
    list.className = "chart-legend";
    figure.append(caption, frame, list);
    host.appendChild(figure);

    const openFrom = (target: Element | null) => {
      const button = target?.closest<HTMLButtonElement>("button[data-service]");
      if (button?.dataset.service && button.dataset.metric) open(button.dataset.service, button.dataset.metric);
    };
    list.addEventListener("click", (event) => openFrom(event.target as Element | null));
    list.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // Stops the browser's own Enter-click so the view opens once.
      event.preventDefault();
      openFrom(event.target as Element | null);
    });

    const handle = createChart(canvas, chart.spec, {
      onPick: (datasetIndex, index) => {
        const target = pickTarget(charts[i], datasetIndex, index);
        if (target) open(target.service, target.metric);
      },
    });
    renderLegend(doc, list, chart.entries);
    return { list, handle };
  });

  return {
    update(data) {
      charts = buildOverviewSpecs(data);
      parts.forEach((part, i) => {
        part.handle.update(charts[i].spec);
        renderLegend(doc, part.list, charts[i].entries);
      });
    },
  };
}
