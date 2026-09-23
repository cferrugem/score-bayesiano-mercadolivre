// Páginas falsas do Mercado Livre, com a mesma estrutura de DOM que a extensão lê.
// O teste ponta a ponta sobe um servidor HTTPS local e o Chromium resolve
// *.mercadolivre.com.br para ele, então o content script roda como em produção.

// Anúncios por página de busca. `rating` é o que o card da busca mostra; o detalhe
// (PRODUCTS) é a fonte do nº de avaliações e das vendas.
export const PRODUCTS = {
  MLB1000001: { rating: 5.0, count: 3, sold: "+5 vendidos", price: [89, 90] },
  MLB1000002: { rating: 4.7, count: 9313, sold: "+10 mil vendidos", price: [129, 0] },
  MLB1000003: { rating: 4.2, count: 86, sold: "+100 vendidos", price: [59, 99] },
  MLB1000004: { rating: null, count: null, sold: null, price: [39, 0] }, // sem avaliações
  MLB1000005: { rating: 4.9, count: 1520, sold: "+1.000 vendidos", price: [249, 0] },
  // página 2
  MLB2000001: { rating: 4.8, count: 40210, sold: "+50 mil vendidos", price: [99, 0] },
  MLB2000002: { rating: 3.1, count: 210, sold: "+500 vendidos", price: [19, 90] },
};

const PAGE_ITEMS = {
  1: ["MLB1000001", "MLB1000002", "MLB1000003", "MLB1000004", "MLB1000005"],
  // MLB1000002 repete: slots de anúncio repetem itens da página anterior.
  2: ["MLB2000001", "MLB1000002", "MLB2000002"],
  3: [],
};

const BASE = "https://lista.mercadolivre.com.br";
export const PAGE_PATHS = { 1: "/calca", 2: "/calca_Desde_49_NoIndex_True", 3: "/calca_Desde_97_NoIndex_True" };

const slug = (id) => `${id.replace("MLB", "MLB-")}-calca-jeans-_JM`;

function card(id, i) {
  const p = PRODUCTS[id];
  // O 3º card de cada página é patrocinado: link de clique com o destino em `urldest`.
  const real = `https://produto.mercadolivre.com.br/${slug(id)}`;
  const href =
    i === 2
      ? `https://click1.mercadolivre.com.br/mclics/clicks/external/MLB/count?a=x&urldest=${encodeURIComponent(
          encodeURIComponent(real)
        )}`
      : `${real}#position=${i + 1}`;
  const review =
    p.rating == null
      ? ""
      : `<div class="poly-component__review-compacted"><span class="polylabel-label">${String(p.rating).replace(
          ".",
          ","
        )}</span></div>`;
  const cents = p.price[1] ? `<span class="andes-money-amount__cents">${String(p.price[1]).padStart(2, "0")}</span>` : "";
  return `<li class="ui-search-layout__item"><div class="poly-card"><div class="poly-card__content">
    <h3 class="poly-component__title-wrapper"><a class="poly-component__title" href="${href}">Calça ${id}</a></h3>
    ${review}
    <div class="poly-component__price">
      <s class="andes-money-amount--previous"><span class="andes-money-amount__fraction">999</span></s>
      <div class="poly-price__current"><span class="andes-money-amount"><span class="andes-money-amount__fraction">${p.price[0]}</span>${cents}</span></div>
    </div>
  </div></div></li>`;
}

// Slot de anúncio sem produto (banner): não tem título e não deve ganhar badges.
const AD_SLOT = '<li class="ui-search-layout__item"><div class="ad-banner">Publicidade</div></li>';

export function searchPage(page) {
  const nodes = [1, 2, 3].map((n) => ({ value: String(n), url: BASE + PAGE_PATHS[n] }));
  // O ML embute o estado como JSON com barras escapadas (/).
  const state = JSON.stringify({ pagination: { pagination_nodes_url: nodes, selected_page: page, last_page: 3 } }).replace(
    /\//g,
    "\\u002F"
  );
  const items = PAGE_ITEMS[page].map(card);
  items.splice(1, 0, AD_SLOT);
  const pager = [1, 2, 3]
    .map(
      (n) =>
        `<li class="andes-pagination__button${n === page ? " andes-pagination__button--current" : ""}"><a class="andes-pagination__link" href="${BASE + PAGE_PATHS[n]}">${n}</a></li>`
    )
    .join("");

  // Como no ML, o grid é montado no cliente — o HTML servido não traz os cards.
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Calça | MercadoLivre</title>
  <style>body{font-family:Arial;background:#ededed;margin:0}.ui-search-results{width:900px;margin:20px auto}
  ol.ui-search-layout{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;list-style:none;padding:0}
  li.ui-search-layout__item{background:#fff;padding:12px}</style></head><body>
  <main><section class="ui-search-results"><ol class="ui-search-layout ui-search-layout--grid"></ol>
  <ul class="andes-pagination">${pager}</ul></section></main>
  <script>window.__PRELOADED_STATE__ = ${state};</script>
  <script>
    setTimeout(() => {
      document.querySelector("ol.ui-search-layout").innerHTML = ${JSON.stringify(items.join(""))};
    }, 150);
  </script></body></html>`;
}

export function productPage(id) {
  const p = PRODUCTS[id];
  if (!p) return null;
  const sub = p.sold ? `Novo  |  ${p.sold}` : "Novo";
  const review =
    p.rating == null
      ? ""
      : `<div class="ui-pdp-review"><span class="ui-pdp-review__rating" aria-hidden="true">${p.rating}</span>
         <span class="ui-pdp-review__amount">(${p.count.toLocaleString("pt-BR")})</span></div>
         ${[70, 15, 8, 4, 3]
           .map(
             (w) =>
               `<span class="ui-review-capability-rating__level__progress-bar__fill-background" style="width: ${w}%"></span>`
           )
           .join("")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head><body>
    <span class="ui-pdp-subtitle">${sub}</span><h1 class="ui-pdp-title">Calça ${id}</h1>${review}</body></html>`;
}
