// Abre um Chromium com a extensão carregada, apontando *.mercadolivre.com.br para o
// servidor local de testes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

export const EXT_DIR = resolve(import.meta.dirname, "../..");

export async function launch(port) {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "mlscore-profile-")), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1200, height: 900 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `--host-resolver-rules=MAP *.mercadolivre.com.br 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = worker.url().split("/")[2];
  return { context, worker, extensionId };
}
