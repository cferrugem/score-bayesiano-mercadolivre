// Parsing do HTML da página de detalhe de um anúncio.
//
// Service workers do MV3 NÃO têm DOMParser; por isso o parsing é feito por regex sobre o
// HTML cru. Módulo separado do background.js para poder ser testado em Node.

// "4.7", "4,7" → 4.7
function parseDecimal(s) {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// "9.313", "9 313" → 9313
function parseInteger(s) {
  const v = parseInt(String(s).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(v) ? v : null;
}

// Plano B para nota e nº de avaliações: o JSON-LD de produto (schema.org), que o ML
// embute para buscadores. Não depende de nome de classe CSS, então sobrevive a
// redesenhos da página que quebrariam as regex do markup visível.
function parseAggregateRating(html) {
  const block = html.match(/"aggregateRating"\s*:\s*\{([^{}]*)\}/);
  if (!block) return { rating: null, count: null };
  const value = block[1].match(/"ratingValue"\s*:\s*"?([\d.,]+)/);
  const count = block[1].match(/"(?:reviewCount|ratingCount)"\s*:\s*"?([\d.]+)/);
  return {
    rating: value ? parseDecimal(value[1]) : null,
    count: count ? parseInteger(count[1]) : null,
  };
}

// "+10 mil vendidos" → { text: "+10 mil", num: 10000 }
export function parseSold(subtitle) {
  if (!subtitle || !/vendido/i.test(subtitle)) return null;
  const after = subtitle.split("|").pop().trim(); // "+10 mil vendidos"
  const text = after.replace(/vendidos?/i, "").trim(); // "+10 mil"
  const sm = after.match(/([\d.,]+)\s*(milh(?:ão|ões)|mil|mi)?/i);
  let num = 0;
  if (sm) {
    // "1.000" é milhar; "1,5 mil" é decimal.
    num = parseFloat(sm[1].replace(/\./g, "").replace(",", "."));
    const u = (sm[2] || "").toLowerCase();
    if (u === "mil") num *= 1e3;
    else if (u === "mi" || u.startsWith("milh")) num *= 1e6;
    num = Math.round(num);
  }
  return { text, num };
}

// A resposta é mesmo uma página de produto? Serve para distinguir "anúncio sem
// avaliações" (resultado legítimo, pode ir para o cache) de captcha, página de erro
// ou login (não pode).
export function looksLikeProductPage(html) {
  return /ui-pdp-(title|container|header)/.test(html) || /"@type"\s*:\s*"Product"/.test(html);
}

export function parseDetail(html) {
  const ratingM = html.match(/ui-pdp-review__rating"[^>]*>\s*([\d.,]+)/);
  const amountM = html.match(/ui-pdp-review__amount"[^>]*>\s*\(([\d.\s]+)\)/);

  let rating = ratingM ? parseDecimal(ratingM[1]) : null;
  let count = amountM ? parseInteger(amountM[1]) : null;
  if (rating == null || count == null) {
    const ld = parseAggregateRating(html);
    rating ??= ld.rating;
    count ??= ld.count;
  }

  // distribuição 5→1 (larguras das barras, em %)
  const dist = [];
  const re = /ui-review-capability-rating__level__progress-bar__fill-background"[^>]*style="width:\s*([\d.]+)%/g;
  let m;
  while ((m = re.exec(html)) !== null) dist.push(parseFloat(m[1]));

  // vendas DO ANÚNCIO (subtítulo, ex.: "Novo  |  +10 mil vendidos"). Diferente do número
  // da busca, que costuma agregar o catálogo inteiro (todos os vendedores) e engana.
  const subM = html.match(/ui-pdp-subtitle"[^>]*>([^<]*)/);
  const sold = parseSold(subM ? subM[1] : null);

  return { rating, count, dist: dist.length === 5 ? dist : null, sold };
}
