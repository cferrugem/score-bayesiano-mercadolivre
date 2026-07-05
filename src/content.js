// Content script — roda nas páginas de busca do Mercado Livre.
// Para cada card: extrai nota + preço + MLB id, pede ao background o nº real de
// avaliações, calcula (1) score bayesiano de QUALIDADE e (2) badge de CUSTO-BENEFÍCIO
// (qualidade por real, normalizado dentro da página). Permite ordenar por qualquer um.

// Namespace do bayes.js. NÃO desestruturar aqui: content scripts do mesmo entry compartilham
// o escopo léxico, então `const { bayesianScore100 } = ...` colidiria com a função homônima
// declarada em bayes.js ("Identifier already declared") e derrubaria todo o script.
const ML = self.MLScore;

const CARD_SEL = "li.ui-search-layout__item";
const PROCESSED = "mlscoreDone";

// Config do usuário (popup), com fallback nos padrões.
let CFG = { ...ML.BAYES_DEFAULTS };

// Referências aos badges assíncronos de cada card (não cabem em dataset).
const valueBadges = new WeakMap();
const soldBadges = new WeakMap();
const reviewsBadges = new WeakMap();

// ---- extração de dados do card ---------------------------------------------
function getTitleAnchor(card) {
  return card.querySelector("a.poly-component__title") || card.querySelector("h3 a, h2 a");
}

function getSearchRating(card) {
  const box = card.querySelector(".poly-component__review-compacted");
  if (!box) return null;
  const label = box.querySelector(".polylabel-label");
  if (!label) return null;
  const v = parseFloat(label.textContent.trim().replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// Preço ATUAL do card (ignora o preço "de/riscado", que fica fora de .poly-price__current).
function getPrice(card) {
  const cur = card.querySelector(".poly-price__current") || card.querySelector(".poly-component__price");
  if (!cur) return null;
  const frac = cur.querySelector(".andes-money-amount__fraction");
  if (!frac) return null;
  const cents = cur.querySelector(".andes-money-amount__cents");
  const intPart = parseInt(frac.textContent.replace(/\D/g, ""), 10);
  const centPart = cents ? parseInt(cents.textContent.replace(/\D/g, ""), 10) : 0;
  if (!Number.isFinite(intPart)) return null;
  return intPart + (Number.isFinite(centPart) ? centPart : 0) / 100;
}

// Resolve o href do card para a URL real do produto + MLB id (trata redirect de anúncio).
function resolveProduct(anchor) {
  if (!anchor) return null;
  let url = anchor.href;
  try {
    if (/click\d*\.mercadolivre|\/mclics\//.test(url)) {
      const u = new URL(url);
      const dest = u.searchParams.get("urldest");
      if (dest) url = decodeURIComponent(decodeURIComponent(dest));
    }
  } catch (_) {}

  // MLB id: tenta o padrão da URL e o item_id embutido.
  let id = null;
  const idM = url.match(/MLB-?(\d{6,})/) || url.match(/item_id[=%]?3?D?MLB(\d{6,})/i);
  if (idM) id = "MLB" + idM[1];

  return id ? { mlbId: id, productUrl: url.split("#")[0] } : null;
}

// ---- badges ----------------------------------------------------------------
function makeBadge(cls, text) {
  const b = document.createElement("div");
  b.className = cls;
  b.textContent = text;
  return b;
}

function renderQuality(badge, { score, rating, count, error }) {
  badge.classList.remove("mlscore-badge--loading");
  if (error || score == null) {
    badge.classList.add("mlscore-badge--error");
    badge.textContent = rating != null ? `nota ${rating} · s/ nº aval.` : "sem dados";
    badge.title = error || "Não foi possível obter o número de avaliações.";
    return;
  }
  badge.style.background = ML.scoreColor(score);
  badge.textContent = `Qualidade ${score}`;
  badge.title = `Score bayesiano de qualidade ${score}/100\nNota ${rating} · ${count.toLocaleString("pt-BR")} avaliações`;
}

// Nº EXATO de avaliações — só existe na página de detalhe (a busca não expõe).
function renderReviews(card, count) {
  const badge = reviewsBadges.get(card);
  if (!badge) return;
  badge.classList.remove("mlscore-reviews--loading");
  if (count && count > 0) {
    badge.textContent = `⭐ ${count.toLocaleString("pt-BR")}`;
    badge.title = `${count.toLocaleString("pt-BR")} avaliações (número exato, da página do produto)`;
    card.dataset.mlreviews = String(count);
  } else {
    badge.textContent = "⭐ —";
    badge.title = "Este anúncio não tem avaliações.";
    delete card.dataset.mlreviews;
  }
}

// Vendas — vem do DETALHE do anúncio (não da busca, que agrega o catálogo e engana).
function renderSold(card, sold) {
  const badge = soldBadges.get(card);
  if (!badge) return;
  badge.classList.remove("mlscore-sold--loading");
  if (sold && sold.num > 0) {
    badge.textContent = `🛒 ${sold.text}`;
    badge.title = `${sold.num.toLocaleString("pt-BR")} vendidos deste anúncio (aprox.)`;
    card.dataset.mlsold = String(sold.num);
  } else {
    badge.textContent = "🛒 —";
    badge.title = "Este anúncio não informa a quantidade vendida.";
    delete card.dataset.mlsold;
  }
}

// Recalcula o custo-benefício de TODOS os cards já pontuados (normaliza pela página).
function refreshValueBadges() {
  const cards = Array.from(document.querySelectorAll(CARD_SEL)).filter((c) => valueBadges.has(c));
  const raws = cards.map((c) => {
    const score = Number(c.dataset.mlscore);
    const price = Number(c.dataset.mlprice);
    return ML.valueRaw(score >= 0 ? score : null, price > 0 ? price : null);
  });
  const norm = ML.normalizeValues(raws);
  cards.forEach((c, i) => {
    const badge = valueBadges.get(c);
    const v = norm[i];
    c.dataset.mlvalue = String(v ?? -1);
    if (v == null) {
      badge.className = "mlscore-badge mlscore-badge--error";
      badge.textContent = "C/B —";
      badge.title = "Sem preço ou score para calcular custo-benefício.";
    } else {
      badge.className = "mlscore-cb";
      badge.textContent = `C/B ${v}`;
      badge.title = `Custo-benefício ${v}/100 (relativo aos resultados desta página)\nMelhor relação qualidade/preço = 100`;
    }
  });
  // Se o usuário escolheu uma ordem que depende de dados assíncronos, reaplica.
  if (["quality", "value", "reviews", "sold"].includes(currentSort)) applySort(currentSort);
}

// ---- processamento de um card ----------------------------------------------
let orderCounter = 0;

function processCard(card) {
  if (card.dataset[PROCESSED]) return;
  card.dataset[PROCESSED] = "1";
  card.dataset.mlorder = String(orderCounter++); // preserva a ordem original (relevância)

  const anchor = getTitleAnchor(card);
  const rating = getSearchRating(card);
  const price = getPrice(card);
  const prod = resolveProduct(anchor);

  const host = card.querySelector(".poly-card__content") || card;
  const wrap = document.createElement("div");
  wrap.className = "mlscore-wrap";
  const quality = makeBadge("mlscore-badge mlscore-badge--loading", "qualidade…");
  const value = makeBadge("mlscore-cb mlscore-cb--loading", "C/B…");
  const reviewsBadge = makeBadge("mlscore-reviews mlscore-reviews--loading", "⭐…");
  const soldBadge = makeBadge("mlscore-sold mlscore-sold--loading", "🛒…");
  wrap.append(quality, value, reviewsBadge, soldBadge);
  host.prepend(wrap);

  valueBadges.set(card, value);
  reviewsBadges.set(card, reviewsBadge);
  soldBadges.set(card, soldBadge);
  if (price != null) card.dataset.mlprice = String(price);

  if (!prod) {
    renderQuality(quality, { score: null, rating, error: "Não foi possível identificar o produto." });
    card.dataset.mlscore = "-1";
    renderReviews(card, null);
    renderSold(card, null);
    refreshValueBadges();
    return;
  }

  chrome.runtime.sendMessage(
    { type: "getReviews", mlbId: prod.mlbId, productUrl: prod.productUrl },
    (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        const error = chrome.runtime.lastError?.message || resp?.error;
        renderQuality(quality, { score: null, rating, error });
        card.dataset.mlscore = "-1";
        renderReviews(card, null);
        renderSold(card, null);
        refreshValueBadges();
        return;
      }
      // Nota: prefere a do detalhe (mais precisa); cai p/ a da busca se faltar.
      const R = resp.data.rating ?? rating;
      const n = resp.data.count ?? 0;
      if (R == null) {
        renderQuality(quality, { score: null, rating: null, error: "Sem avaliações." });
        card.dataset.mlscore = "-1";
      } else {
        const score = ML.bayesianScore100(R, n, CFG);
        card.dataset.mlscore = String(score ?? -1);
        renderQuality(quality, { score, rating: R, count: n });
      }
      // Avaliações (nº exato) e vendas (faixa): SEMPRE do detalhe.
      renderReviews(card, n);
      renderSold(card, resp.data.sold);
      refreshValueBadges();
    }
  );
}

function scanCards() {
  document.querySelectorAll(CARD_SEL).forEach(processCard);
}

// ---- ordenação -------------------------------------------------------------
// modo -> { attr: dataset a usar, asc: crescente? }. Faltando o valor, o card vai pro fim.
const SORT_MODES = {
  rel: { attr: "mlorder", asc: true },
  quality: { attr: "mlscore", asc: false },
  value: { attr: "mlvalue", asc: false },
  reviews: { attr: "mlreviews", asc: false },
  sold: { attr: "mlsold", asc: false },
  "price-asc": { attr: "mlprice", asc: true },
  "price-desc": { attr: "mlprice", asc: false },
};

let currentSort = "rel";

function applySort(mode) {
  currentSort = mode;
  const { attr, asc } = SORT_MODES[mode] || SORT_MODES.rel;
  const list = document.querySelector("ol.ui-search-layout, ol.ui-search-layout--grid");
  if (!list) return;
  const missing = asc ? Infinity : -Infinity; // sem valor => sempre por último
  Array.from(list.querySelectorAll(":scope > li.ui-search-layout__item"))
    .sort((a, b) => {
      const av = Number(a.dataset[attr]);
      const bv = Number(b.dataset[attr]);
      const aa = Number.isFinite(av) && av >= 0 ? av : missing;
      const bb = Number.isFinite(bv) && bv >= 0 ? bv : missing;
      return asc ? aa - bb : bb - aa;
    })
    .forEach((li) => list.appendChild(li));
}

function injectToolbar() {
  if (document.getElementById("mlscore-toolbar")) return;
  const anchor =
    document.querySelector(".ui-search-search-result") ||
    document.querySelector(".ui-search-results");
  if (!anchor) return;
  const bar = document.createElement("div");
  bar.id = "mlscore-toolbar";
  bar.innerHTML =
    '<span class="mlscore-toolbar__title">Score bayesiano</span>' +
    '<label class="mlscore-toolbar__label">Ordenar por' +
    '<select id="mlscore-order" class="mlscore-toolbar__select">' +
    '<option value="rel">Relevância (padrão)</option>' +
    '<option value="quality">Qualidade</option>' +
    '<option value="value">Custo-benefício</option>' +
    '<option value="reviews">Mais avaliados</option>' +
    '<option value="sold">Mais vendidos</option>' +
    '<option value="price-asc">Menor preço</option>' +
    '<option value="price-desc">Maior preço</option>' +
    "</select></label>";
  anchor.prepend(bar);
  const select = bar.querySelector("#mlscore-order");
  select.value = currentSort;
  select.addEventListener("change", (e) => applySort(e.target.value));
}

// ---- inicialização + observação de novos cards -----------------------------
async function init() {
  try {
    const { config } = await chrome.storage.local.get("config");
    if (config) CFG = { ...ML.BAYES_DEFAULTS, ...config };
  } catch (_) {}
  injectToolbar();
  scanCards();
}

const observer = new MutationObserver(() => {
  injectToolbar();
  scanCards();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

init();
