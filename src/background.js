// Service worker (MV3, módulo). Busca a página de detalhe de cada produto em segundo plano
// e extrai nota + nº de avaliações + distribuição, com cache e limite de concorrência.
//
// Obs.: service workers do MV3 NÃO têm DOMParser; por isso o parsing é feito por regex
// sobre o HTML cru. Os seletores foram validados em páginas reais do Mercado Livre.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CONCURRENCY = 4;
const REQUEST_DELAY_MS = 120; // respiro entre requisições p/ evitar rate limit

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

// ---- cache em chrome.storage.local -----------------------------------------
async function cacheGet(mlbId) {
  const key = `rev:${mlbId}`;
  const store = await chrome.storage.local.get(key);
  const entry = store[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  return null;
}

async function cacheSet(mlbId, data) {
  await chrome.storage.local.set({ [`rev:${mlbId}`]: { ts: Date.now(), data } });
}

// ---- parsing do HTML de detalhe --------------------------------------------
function parseDetail(html) {
  const ratingM = html.match(/ui-pdp-review__rating"[^>]*>\s*([\d.,]+)/);
  const amountM = html.match(/ui-pdp-review__amount"[^>]*>\s*\(([\d.\s]+)\)/);

  const rating = ratingM ? parseFloat(ratingM[1].replace(",", ".")) : null;
  const count = amountM ? parseInt(amountM[1].replace(/[^\d]/g, ""), 10) : null;

  // distribuição 5→1 (larguras das barras, em %)
  const dist = [];
  const re = /ui-review-capability-rating__level__progress-bar__fill-background"[^>]*style="width:\s*([\d.]+)%/g;
  let m;
  while ((m = re.exec(html)) !== null) dist.push(parseFloat(m[1]));

  // vendas DO ANÚNCIO (subtítulo, ex.: "Novo  |  +10 mil vendidos"). Diferente do número
  // da busca, que costuma agregar o catálogo inteiro (todos os vendedores) e engana.
  let sold = null;
  const subM = html.match(/ui-pdp-subtitle"[^>]*>([^<]*)/);
  if (subM && /vendido/i.test(subM[1])) {
    const after = subM[1].split("|").pop().trim(); // "+10 mil vendidos"
    const text = after.replace(/vendidos?/i, "").trim(); // "+10 mil"
    const sm = after.match(/([\d.,]+)\s*(milh(?:ão|ões)|mil|mi)?/i);
    let num = 0;
    if (sm) {
      num = parseFloat(sm[1].replace(/\./g, "").replace(",", "."));
      const u = (sm[2] || "").toLowerCase();
      if (u === "mil") num *= 1e3;
      else if (u === "mi" || u.startsWith("milh")) num *= 1e6;
      num = Math.round(num);
    }
    sold = { text, num };
  }

  return { rating, count, dist: dist.length === 5 ? dist : null, sold };
}

async function fetchReviews(productUrl) {
  const res = await fetch(productUrl, { credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseDetail(html);
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
    const tabId = sender.tab?.id;
    settleHarvest(tabId, "resolve", msg.cards || []);
    closeTab(tabId);
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

  if (msg?.type !== "getReviews") return false;
  (async () => {
    try {
      const cached = await cacheGet(msg.mlbId);
      if (cached) return sendResponse({ ok: true, data: cached, cached: true });

      const data = await schedule(() => fetchReviews(msg.productUrl));
      if (data.rating != null || data.sold != null) await cacheSet(msg.mlbId, data);
      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // resposta assíncrona
});
