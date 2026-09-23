// Cálculo do score bayesiano. Carregado como content script (escopo global da página isolada).
// Fórmula de encolhimento (shrinkage): score = (C*m + n*R) / (C + n)
//   R = nota média do produto        n = número de avaliações
//   m = média global do nicho (prior)  C = peso do prior (nº de avaliações "fictícias")
// Produtos com poucas avaliações são puxados em direção a `m`; com muitas, o score ≈ R.

const BAYES_DEFAULTS = {
  priorMean: 4.3, // m — média típica de nota no Mercado Livre
  priorWeight: 30, // C — quantas avaliações são necessárias para "confiar" na nota
  minReviews: 0, // esconde anúncios com menos avaliações que isto (0 = não esconde)
  maxStars: 5,
};

// Limites dos controles do popup. A config vem do storage, que pode ter sido escrito
// por uma versão antiga ou corrompido: fora destes limites, vale o padrão.
const BAYES_LIMITS = {
  priorMean: [1, 5],
  priorWeight: [1, 1000],
  minReviews: [0, 100000],
};

function sanitizeConfig(raw) {
  const cfg = { ...BAYES_DEFAULTS };
  for (const [key, [lo, hi]] of Object.entries(BAYES_LIMITS)) {
    const v = Number(raw?.[key]);
    if (raw?.[key] != null && Number.isFinite(v) && v >= lo && v <= hi) cfg[key] = v;
  }
  return cfg;
}

function bayesianScore(rating, count, cfg = BAYES_DEFAULTS) {
  const R = Number(rating);
  const n = Number(count) || 0;
  const m = cfg.priorMean;
  const C = cfg.priorWeight;
  if (rating == null || !Number.isFinite(R)) return null;
  return (C * m + n * R) / (C + n);
}

// Score em escala 0–100 para exibição/ordenação, normalizado pela nota máxima.
function bayesianScore100(rating, count, cfg = BAYES_DEFAULTS) {
  const s = bayesianScore(rating, count, cfg);
  if (s === null) return null;
  return Math.round((s / cfg.maxStars) * 1000) / 10; // uma casa decimal
}

// Cor do badge conforme faixa do score (0–100). Tons escurecidos em relação à paleta
// do ML para o texto branco em negrito de 12px passar de 4,5:1 (WCAG AA).
function scoreColor(score100) {
  if (score100 == null) return "#6b7280";
  if (score100 >= 90) return "#00843f"; // verde
  if (score100 >= 80) return "#2968c8"; // azul
  if (score100 >= 70) return "#b35c00"; // âmbar
  return "#d0342c"; // vermelho
}

// Número no formato brasileiro, sem casas decimais inúteis: 94 → "94", 87.3 → "87,3".
function formatNumber(n, maxDigits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("pt-BR", { maximumFractionDigits: maxDigits });
}

// ---- custo-benefício -------------------------------------------------------
// Valor "bruto" = pontos de qualidade por real. É comparável só dentro do mesmo
// conjunto de resultados, então normalizamos depois pelo melhor valor da página.
function valueRaw(score100, price) {
  const p = Number(price);
  if (score100 == null || !Number.isFinite(p) || p <= 0) return null;
  return score100 / p;
}

// Normaliza uma lista de valores brutos para 0–100 (o melhor da página = 100).
function normalizeValues(rawList) {
  const max = Math.max(...rawList.filter((v) => v != null && Number.isFinite(v)), 0);
  return rawList.map((v) => (v == null || max <= 0 ? null : Math.round((v / max) * 100)));
}

// Expõe no escopo global do content script (e do popup / testes em Node).
globalThis.MLScore = {
  BAYES_DEFAULTS,
  BAYES_LIMITS,
  sanitizeConfig,
  bayesianScore,
  bayesianScore100,
  scoreColor,
  formatNumber,
  valueRaw,
  normalizeValues,
};
