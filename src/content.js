// Content script — roda nas páginas de busca do Mercado Livre.
// Para cada card: extrai nota + preço + MLB id, pede ao background o nº real de
// avaliações, calcula (1) score bayesiano de QUALIDADE e (2) badge de CUSTO-BENEFÍCIO
// (qualidade por real, normalizado dentro da página). Permite ordenar por qualquer um.

// Namespace do bayes.js. NÃO desestruturar aqui: content scripts do mesmo entry compartilham
// o escopo léxico, então `const { bayesianScore100 } = ...` colidiria com a função homônima
// declarada em bayes.js ("Identifier already declared") e derrubaria todo o script.
const ML = self.MLScore;
const MLP = self.MLPages;

const CARD_SEL = "li.ui-search-layout__item";
const PROCESSED = "mlscoreDone";

// Quantas páginas da busca podem ficar na mesma tela (a atual + as carregadas).
const MAX_PAGES = 3;

// Páginas já presentes no grid, em ordem de chegada.
const loadedPages = [];
let loadingPage = false;

// Config do usuário (popup), com fallback nos padrões.
let CFG = { ...ML.BAYES_DEFAULTS };

// Referências aos badges assíncronos de cada card (não cabem em dataset).
const valueBadges = new WeakMap();
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
// Sem badge: o próprio card do ML já mostra "+N vendidos". Guarda só o dado p/ ordenar.
function renderSold(card, sold) {
  if (sold && sold.num > 0) {
    card.dataset.mlsold = String(sold.num);
  } else {
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
  else syncToolbar();
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
  wrap.append(quality, value, reviewsBadge);
  host.prepend(wrap);

  valueBadges.set(card, value);
  reviewsBadges.set(card, reviewsBadge);
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
  syncToolbar();
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

// ---- páginas seguintes -----------------------------------------------------
// MLB id do card, para não repetir anúncio: cada página traz ~60 <li> para 48 produtos,
// e os slots de anúncio extras podem repetir itens que já estão na tela.
function cardMlbId(card) {
  const prod = resolveProduct(getTitleAnchor(card));
  return prod ? prod.mlbId : null;
}

// Próxima página a carregar, ou null se não há mais (ou se já bateu o limite).
function nextPageNumber() {
  if (!MLP || loadedPages.length >= MAX_PAGES) return null;
  const { urls, last } = MLP.pagination();
  const next = loadedPages[loadedPages.length - 1] + 1;
  return next <= last && urls[String(next)] ? next : null;
}

function appendCards(htmls) {
  const grid = document.querySelector("ol.ui-search-layout");
  if (!grid) return 0;

  const seen = new Set();
  document.querySelectorAll(CARD_SEL).forEach((c) => {
    const id = cardMlbId(c);
    if (id) seen.add(id);
  });

  const frag = document.createDocumentFragment();
  let added = 0;
  for (const html of htmls) {
    // Um <div> do documento vivo, e NÃO um <template>: o conteúdo de template pertence
    // a um documento inerte, e as imagens dos cards (loading="lazy") nunca chegam a
    // selecionar fonte — ficam com currentSrc vazio mesmo depois de inseridas na página.
    const host = document.createElement("div");
    host.innerHTML = html.trim();
    const li = host.firstElementChild;
    if (!li) continue;
    const id = cardMlbId(li);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    frag.appendChild(li);
    added++;
  }
  // O MutationObserver cuida do resto: scanCards() pontua os novos cards e
  // refreshValueBadges() renormaliza o custo-benefício sobre o conjunto inteiro.
  grid.appendChild(frag);
  return added;
}

async function loadNextPage() {
  const page = nextPageNumber();
  if (page == null || loadingPage) return;
  loadingPage = true;
  syncToolbar();

  const { urls } = MLP.pagination();
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "loadPage",
      url: urls[String(page)] + MLP.HARVEST_HASH,
    });
    if (!resp?.ok) throw new Error(resp?.error || "Não foi possível carregar a página.");
    const added = appendCards(resp.cards);
    if (!added) throw new Error("A página não trouxe anúncios novos.");
    loadedPages.push(page);
    rewritePagination();
  } catch (err) {
    barMessage(String(err?.message || err));
  } finally {
    loadingPage = false;
    syncToolbar();
  }
}

// Reescreve a paginação nativa do rodapé: as páginas que já estão na tela viram
// marcadores inertes e os links seguem a partir da primeira ainda não carregada.
// Recria os <li> em vez de editá-los — assim os handlers do ML saem junto com os
// nós antigos e os nossos href passam a valer.
function rewritePagination() {
  const ul = document.querySelector("ul.andes-pagination");
  if (!ul || !MLP) return;
  const { urls, last } = MLP.pagination();
  if (!Object.keys(urls).length) return;

  const loaded = new Set(loadedPages);
  const nums = Object.keys(urls)
    .map(Number)
    .sort((a, b) => a - b);

  const items = nums.map((n) => {
    if (loaded.has(n)) {
      return (
        '<li class="andes-pagination__button andes-pagination__button--disabled mlscore-page--loaded">' +
        `<span class="andes-pagination__link" title="Página ${n} já está acima nesta tela">${n}</span></li>`
      );
    }
    return (
      '<li class="andes-pagination__button">' +
      `<a class="andes-pagination__link" href="${urls[String(n)]}" aria-label="Vá para a página ${n}">${n}</a></li>`
    );
  });

  const after = nums.find((n) => !loaded.has(n) && n > Math.max(...loadedPages));
  if (after && after <= last) {
    items.push(
      '<li class="andes-pagination__button andes-pagination__button--next">' +
        `<a class="andes-pagination__link" href="${urls[String(after)]}" title="Seguinte">` +
        '<span class="andes-pagination__arrow-title">Seguinte</span></a></li>'
    );
  }
  ul.innerHTML = items.join("");
}

// Critérios na ordem em que aparecem na barra. `rule: true` abre um grupo novo
// (mérito calculado | preço bruto) — a divisória diz algo real sobre os dados.
const SORT_BUTTONS = [
  { mode: "rel", label: "Relevância", hint: "Ordem original do Mercado Livre" },
  { mode: "quality", label: "Qualidade", hint: "Score bayesiano da nota + nº de avaliações" },
  { mode: "value", label: "Custo-benefício", hint: "Qualidade por real, normalizado nesta página" },
  { mode: "reviews", label: "Avaliações", hint: "Nº exato de avaliações do anúncio" },
  { mode: "sold", label: "Vendas", hint: "Quantidade vendida deste anúncio" },
  { mode: "price-asc", label: "Menor preço", hint: "Preço atual, do mais barato", rule: true },
  { mode: "price-desc", label: "Maior preço", hint: "Preço atual, do mais caro" },
];

// Curva normal: o mark da barra. É a única marca gráfica — o resto é tipografia.
const CURVE_SVG =
  '<svg class="mlscore-bar__mark" viewBox="0 0 18 16" aria-hidden="true">' +
  '<path d="M1 13.5C4 13.5 4.6 2.5 9 2.5s5 11 8 11" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"/></svg>';

function injectToolbar() {
  if (document.getElementById("mlscore-toolbar")) return;
  // A coluna de resultados — NÃO a sidebar, que tem 260px e espreme a barra.
  const results = document.querySelector(".ui-search-results");
  const grid = results && results.querySelector("ol.ui-search-layout");
  if (!results || !grid) return;

  const bar = document.createElement("div");
  bar.id = "mlscore-toolbar";
  bar.innerHTML =
    '<div class="mlscore-bar__left">' +
    CURVE_SVG +
    '<div class="mlscore-bar__idtext">' +
    '<span class="mlscore-bar__name">Score bayesiano</span>' +
    '<span class="mlscore-bar__meter" id="mlscore-meter">lendo anúncios…</span>' +
    "</div>" +
    // O botão fica junto do bloco de identidade, não solto: com três blocos irmãos a
    // barra empilha em três linhas em coluna estreita, e ela é fixa ao rolar.
    '<button type="button" class="mlscore-more" id="mlscore-more" hidden></button>' +
    "</div>" +
    // Sem rótulo "Ordenar por": ele custava ~93px e empurrava a barra para duas linhas na
    // coluna de 1184px. Os próprios critérios dizem que são ordenação (o par Menor/Maior
    // preço não deixa dúvida) e o aria-label mantém a leitura por leitor de tela.
    '<div class="mlscore-bar__sort" role="group" aria-label="Ordenar resultados por">' +
    SORT_BUTTONS.map(
      (b) =>
        (b.rule ? '<span class="mlscore-bar__rule" aria-hidden="true"></span>' : "") +
        `<button type="button" class="mlscore-pill" data-mode="${b.mode}" title="${b.hint}">${b.label}</button>`
    ).join("") +
    "</div>" +
    '<div class="mlscore-bar__progress"><i id="mlscore-progress"></i></div>';

  results.insertBefore(bar, grid);

  bar.querySelectorAll(".mlscore-pill").forEach((btn) => {
    btn.addEventListener("click", () => applySort(btn.dataset.mode));
  });
  bar.querySelector("#mlscore-more").addEventListener("click", loadNextPage);
  syncToolbar();
}

// Mensagem passageira na linha do contador (falha ao carregar página, p. ex.).
let messageTimer = null;
function barMessage(text) {
  const meter = document.getElementById("mlscore-meter");
  if (!meter) return;
  meter.textContent = text;
  meter.classList.add("mlscore-bar__meter--warn");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    meter.classList.remove("mlscore-bar__meter--warn");
    syncToolbar();
  }, 4000);
}

// Estado dos pills + leitura de progresso. O contador não é enfeite: enquanto os
// dados chegam do detalhe, ordenar por qualidade/C-B usa página incompleta.
function syncToolbar() {
  const bar = document.getElementById("mlscore-toolbar");
  if (!bar) return;
  bar.querySelectorAll(".mlscore-pill").forEach((btn) => {
    const on = btn.dataset.mode === currentSort;
    btn.classList.toggle("mlscore-pill--on", on);
    btn.setAttribute("aria-pressed", String(on));
  });

  const cards = document.querySelectorAll(CARD_SEL);
  const total = cards.length;
  let done = 0;
  cards.forEach((c) => {
    if (c.dataset.mlscore !== undefined) done++;
  });
  // Botão de próxima página: some quando não há mais o que somar.
  const more = bar.querySelector("#mlscore-more");
  const next = nextPageNumber();
  if (loadingPage) {
    more.hidden = false;
    more.disabled = true;
    more.textContent = "Carregando…";
  } else if (next == null) {
    more.hidden = true;
  } else {
    more.hidden = false;
    more.disabled = false;
    more.textContent = `+ Página ${next}`;
    more.title = `Soma os anúncios da página ${next} a esta tela`;
  }

  const meter = bar.querySelector("#mlscore-meter");
  const fill = bar.querySelector("#mlscore-progress");
  if (!total || meter.classList.contains("mlscore-bar__meter--warn")) return;
  const pages = loadedPages.length > 1 ? ` · páginas ${loadedPages[0]}–${loadedPages[loadedPages.length - 1]}` : "";
  meter.textContent =
    (done < total ? `${done} de ${total} anúncios pontuados` : `${total} anúncios pontuados`) + pages;
  bar.classList.toggle("mlscore-bar--ready", done >= total);
  fill.style.width = `${Math.round((done / total) * 100)}%`;
}

// ---- inicialização + observação de novos cards -----------------------------
async function init() {
  try {
    const { config } = await chrome.storage.local.get("config");
    if (config) CFG = { ...ML.BAYES_DEFAULTS, ...config };
  } catch (_) {}
  loadedPages.push(MLP ? MLP.pagination().selected : 1);
  injectToolbar();
  scanCards();
}

// Numa aba de colheita nada disso roda: ela existe só para renderizar e entregar os
// cards (pages.js cuida). Injetar a barra e pontuar ali dobraria os fetches de detalhe.
if (!MLP || !MLP.isHarvest) {
  const observer = new MutationObserver(() => {
    injectToolbar();
    scanCards();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  init();
}
