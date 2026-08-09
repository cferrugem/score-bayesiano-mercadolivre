// Carregamento das páginas seguintes da busca.
//
// Por que aba em segundo plano e não fetch: o grid de resultados do Mercado Livre é
// renderizado no cliente. Um fetch traz o HTML sem nenhum card (vale até para a página
// que já está aberta), e o app se recusa a renderizar dentro de iframe — verificado:
// com window.top !== self só o cabeçalho sai, mesmo com o iframe visível e após 20s.
// A API pública responde 403. Uma aba de verdade, mesmo inativa e com visibilityState
// "hidden", renderiza o grid inteiro — é o único caminho que entrega cards corretos.
//
// Tudo vive dentro de uma IIFE de propósito: bayes.js e content.js são scripts clássicos
// que compartilham o escopo léxico da página, então um global homônimo aqui derrubaria
// os três de uma vez ("Identifier already declared").

(() => {
  const HARVEST_HASH = "#mlscore-harvest";
  const GRID_SEL = "ol.ui-search-layout";
  const ITEM_SEL = "li.ui-search-layout__item";
  const TITLE_SEL = "a.poly-component__title";

  // Esta aba foi aberta por nós só para renderizar e entregar os cards?
  const isHarvest = location.hash === HARVEST_HASH;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- URLs das páginas ------------------------------------------------------
  // Vêm do estado embutido do próprio ML (pagination_nodes_url), já com categoria e
  // filtros resolvidos. Montar "_Desde_N" na mão erraria sempre que houvesse filtro.
  // O HTML é grande (~1 MB), então lê uma vez e guarda.
  let cached = null;

  function readPagination() {
    if (cached) return cached;
    cached = { urls: {}, selected: 1, last: 1 };
    try {
      const raw = document.documentElement.outerHTML
        .replace(/\\u002F/gi, "/")
        .replace(/\\"/g, '"');
      const block = raw.match(/"pagination_nodes_url":\[(.*?)\]/s);
      if (block) {
        for (const m of block[1].matchAll(/"value":"(\d+)","url":"(.*?)"/g)) {
          cached.urls[m[1]] = m[2];
        }
      }
      const sel = raw.match(/"selected_page":(\d+)/);
      if (sel) cached.selected = parseInt(sel[1], 10);
      const last = raw.match(/"last_page":(\d+)/);
      if (last) cached.last = parseInt(last[1], 10);
    } catch (_) {
      // Sem paginação legível o botão simplesmente não aparece.
    }
    return cached;
  }

  // ---- modo colheita ---------------------------------------------------------
  // Espera o grid renderizar. "Pronto" = a contagem parou de crescer, não só ficou > 0:
  // o ML pinta os cards em levas e sair cedo demais traria meia página.
  async function waitForGrid() {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 72; i++) {
      const n = document.querySelectorAll(`${GRID_SEL} > ${ITEM_SEL}`).length;
      if (n > 0 && n === last) {
        if (++stable >= 2) return n;
      } else {
        stable = 0;
      }
      last = n;
      await sleep(250);
    }
    return Math.max(last, 0);
  }

  async function harvest() {
    await waitForGrid();
    const cards = [...document.querySelectorAll(`${GRID_SEL} > ${ITEM_SEL}`)]
      .filter((li) => li.querySelector(TITLE_SEL)) // descarta slots de anúncio sem produto
      .map((li) => li.outerHTML);
    // Mesmo vindo vazio, responde: é o que solta o background em vez de deixá-lo
    // esperando até o timeout.
    try {
      chrome.runtime.sendMessage({ type: "harvested", cards });
    } catch (_) {}
  }

  self.MLPages = {
    isHarvest,
    HARVEST_HASH,
    pagination: readPagination,
  };

  if (isHarvest) harvest();
})();
