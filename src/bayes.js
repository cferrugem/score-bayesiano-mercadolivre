// Cálculo do score bayesiano. Carregado como content script (escopo global da página isolada).
// Fórmula de encolhimento (shrinkage): score = (C*m + n*R) / (C + n)
//   R = nota média do produto        n = número de avaliações
//   m = média global do nicho (prior)  C = peso do prior (nº de avaliações "fictícias")
// Produtos com poucas avaliações são puxados em direção a `m`; com muitas, o score ≈ R.

const BAYES_DEFAULTS = {
  priorMean: 4.3, // m — média típica de nota no Mercado Livre
  priorWeight: 30, // C — quantas avaliações são necessárias para "confiar" na nota
  maxStars: 5,
};

function bayesianScore(rating, count, cfg = BAYES_DEFAULTS) {
  const R = Number(rating);
  const n = Number(count) || 0;
  const m = cfg.priorMean;
  const C = cfg.priorWeight;
  if (!Number.isFinite(R)) return null;
  return (C * m + n * R) / (C + n);
}

// Score em escala 0–100 para exibição/ordenação, normalizado pela nota máxima.
function bayesianScore100(rating, count, cfg = BAYES_DEFAULTS) {
  const s = bayesianScore(rating, count, cfg);
  if (s === null) return null;
  return Math.round((s / cfg.maxStars) * 1000) / 10; // uma casa decimal
}

// Cor do badge conforme faixa do score (0–100).
function scoreColor(score100) {
  if (score100 == null) return "#9aa0a6";
  if (score100 >= 90) return "#00a650"; // verde ML
  if (score100 >= 80) return "#3483fa"; // azul ML
  if (score100 >= 70) return "#f5a623"; // âmbar
  return "#e74c3c"; // vermelho
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

// Expõe no escopo global do content script.
self.MLScore = {
  BAYES_DEFAULTS,
  bayesianScore,
  bayesianScore100,
  scoreColor,
  valueRaw,
  normalizeValues,
};
