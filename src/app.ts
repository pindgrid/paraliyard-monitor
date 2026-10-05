import { loadConfig } from "./config";
import { createPoller, type Poller } from "./poller";
import { renderDashboard } from "./render";
import { SERVICES } from "./services";
import { createLiveSource, createMockSource } from "./source";
import type { Config, MetricsResponse } from "./types";

// Open tabs in live mode re-read /config.json this often to honour the kill switch.
export const CONFIG_RECHECK_MS = 10 * 60 * 1000;

export interface AppOptions {
  root: HTMLElement;
  fetchFn?: typeof fetch;
  doc?: Document;
  config?: Config;
}

export interface AppHandle {
  stop(): void;
}

export async function startApp({ root, fetchFn = fetch, doc = document, config }: AppOptions): Promise<AppHandle> {
  const cfg = config ?? (await loadConfig(fetchFn));
  const renderPaused = () => renderDashboard(root, SERVICES, null, { state: "paused" });

  if (cfg.mode === "off") {
    renderPaused();
    return { stop() {} };
  }

  const mock = cfg.mode === "mock";
  const source = mock ? createMockSource() : createLiveSource(fetchFn);
  const pollers: Poller[] = [];
  let stopped = false;
  let last: MetricsResponse | null = null;

  const stop = () => {
    stopped = true;
    for (const poller of pollers) poller.stop();
  };

  renderDashboard(root, SERVICES, null, { state: "loading", mock });

  pollers.push(
    createPoller({
      intervalMs: cfg.refreshSeconds * 1000,
      doc,
      task: async () => {
        try {
          const data = await source.load();
          if (stopped) return;
          last = data;
          renderDashboard(root, SERVICES, data, {
            state: data.stale ? "stale" : "ok",
            updatedAt: data.generatedAt,
            mock,
          });
        } catch (err) {
          if (!stopped) {
            renderDashboard(root, SERVICES, last, { state: "error", updatedAt: last?.generatedAt ?? null, mock });
          }
          throw err;
        }
      },
    }),
  );

  if (cfg.mode === "live") {
    pollers.push(
      createPoller({
        intervalMs: CONFIG_RECHECK_MS,
        doc,
        runImmediately: false,
        task: async () => {
          const next = await loadConfig(fetchFn);
          if (next.mode === "off" && !stopped) {
            stop();
            renderPaused();
          }
        },
      }),
    );
  }

  for (const poller of pollers) poller.start();
  return { stop };
}
