// Service worker (MV3, módulo). Busca a página de detalhe de cada produto em segundo plano
// e extrai nota + nº de avaliações + distribuição, com cache e limite de concorrência.
// O parsing em si mora em parse.js (testável em Node).

import { looksLikeProductPage, parseDetail } from "./parse.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Anúncio sem avaliação nem venda: o resultado é legítimo, mas muda mais rápido que o
// de um anúncio consolidado — e, se o parser quebrou, o dano dura só algumas horas.
const EMPTY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CONCURRENCY = 4;
const REQUEST_DELAY_MS = 120; // respiro entre requisições p/ evitar rate limit
const MAX_RETRIES = 2; // para 429/5xx, com espera crescente
const RETRY_BASE_MS = 1500;

// ---- fila com concorrência limitada ----------------------------------------
let active = 0;
const queue = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENCY && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        setTimeout(pump, REQUEST_DELAY_MS);
      });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- cache em chrome.storage.local -----------------------------------------
const CACHE_PREFIX = "rev:";

function isFresh(entry, now = Date.now()) {
  return entry && now - entry.ts < (entry.ttl || CACHE_TTL_MS);
}

async function cacheGet(mlbId) {
  const key = CACHE_PREFIX + mlbId;
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  return isFresh(entry) ? entry.data : null;
}

async function cacheSet(mlbId, data, ttl) {
  await chrome.storage.local.set({ [CACHE_PREFIX + mlbId]: { ts: Date.now(), ttl, data } });
}

async function cacheKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
}

// Entradas vencidas nunca eram apagadas, só ignoradas: o storage crescia sem limite.
async function purgeExpired() {
  const now = Date.now();
  const stale = (await cacheKeys()).filter(([, v]) => !isFresh(v, now)).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

chrome.runtime.onStartup.addListener(() => purgeExpired().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => purgeExpired().catch(() => {}));

// ---- busca do detalhe ------------------------------------------------------
async function fetchReviews(productUrl) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(productUrl, { credentials: "include", redirect: "follow" });
    // 429 (rate limit) e 5xx costumam passar sozinhos: espera e tenta de novo.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { ...parseDetail(html), isProduct: looksLikeProductPage(html) };
  }
}

// Pedidos simultâneos do mesmo anúncio (duas abas, ou o mesmo item em duas páginas)
// compartilham um único fetch.
const inflight = new Map();

async function getReviews(mlbId, productUrl) {
  const cached = await cacheGet(mlbId);
  if (cached) return { data: cached, cached: true };

  if (!inflight.has(mlbId)) {
    const job = schedule(() => fetchReviews(productUrl))
      .then(async ({ isProduct, ...data }) => {
        if (data.rating != null || data.sold != null) await cacheSet(mlbId, data);
        else if (isProduct) await cacheSet(mlbId, data, EMPTY_TTL_MS);
        return data;
      })
      .finally(() => inflight.delete(mlbId));
    inflight.set(mlbId, job);
  }
  return { data: await inflight.get(mlbId), cached: false };
}

// ---- colheita de páginas seguintes -----------------------------------------
// Abre a página numa aba inativa, espera o content script de lá devolver os cards já
// renderizados e fecha a aba. É o único jeito de obter cards corretos: fetch traz HTML
// sem grid e o app do ML não renderiza dentro de iframe (ver src/pages.js).
const HARVEST_TIMEOUT_MS = 20000;
const harvests = new Map(); // tabId -> { resolve, reject, timer }

function closeTab(tabId) {
  if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
}

function settleHarvest(tabId, fn, arg) {
  const pend = harvests.get(tabId);
  if (!pend) return false;
  clearTimeout(pend.timer);
  harvests.delete(tabId);
  pend[fn](arg);
  return true;
}

async function harvestPage(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      harvests.delete(tab.id);
      closeTab(tab.id);
      reject(new Error("A página demorou demais para carregar."));
    }, HARVEST_TIMEOUT_MS);
    harvests.set(tab.id, { resolve, reject, timer });
  });
}

// Se o usuário fechar a aba na mão, não deixa a promessa pendurada até o timeout.
chrome.tabs.onRemoved.addListener((tabId) => {
  settleHarvest(tabId, "reject", new Error("A aba foi fechada antes de terminar."));
});

// ---- mensageria ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "harvested") {
    // Só fecha abas que nós mesmos abrimos: um link colado com o hash de colheita
    // não pode fazer a aba do usuário sumir.
    const tabId = sender.tab?.id;
    if (settleHarvest(tabId, "resolve", msg.cards || [])) closeTab(tabId);
    return false;
  }

  if (msg?.type === "loadPage") {
    (async () => {
      try {
        sendResponse({ ok: true, cards: await harvestPage(msg.url) });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // resposta assíncrona
  }

  if (msg?.type === "cacheStats") {
    cacheKeys().then(
      (entries) => sendResponse({ ok: true, count: entries.filter(([, v]) => isFresh(v)).length }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) })
    );
    return true;
  }

  if (msg?.type === "clearCache") {
    cacheKeys()
      .then((entries) => chrome.storage.local.remove(entries.map(([k]) => k)))
      .then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) })
      );
    return true;
  }

  if (msg?.type !== "getReviews") return false;
  getReviews(msg.mlbId, msg.productUrl).then(
    ({ data, cached }) => sendResponse({ ok: true, data, cached }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // resposta assíncrona
});
