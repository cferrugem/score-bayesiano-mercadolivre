// Popup de configuração. Reaproveita src/bayes.js — os números e as cores da prévia
// são calculados exatamente pela mesma função que roda nos cards da busca.
// NÃO desestruturar: bayes.js é um script clássico e compartilha o escopo léxico desta
// página, então `const { BAYES_DEFAULTS } = ...` colidiria com a const homônima de lá
// ("Identifier already declared") e derrubaria todo o popup — igual ao content.js.
const ML = globalThis.MLScore;

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

// Casos que mostram o que o prior faz. O primeiro é a armadilha que a extensão existe
// para desarmar: nota cheia com pouquíssimas avaliações.
const EXAMPLES = [
  { rating: 5.0, count: 3 },
  { rating: 4.7, count: 9313 },
  { rating: 4.2, count: 86 },
];

// Degraus do slider de mínimo de avaliações (o valor do input é o índice).
const MIN_REVIEW_STEPS = [0, 5, 10, 25, 50, 100, 250, 500];

function stepIndex(minReviews) {
  // Valor salvo fora dos degraus (config antiga): usa o maior degrau que não passa dele.
  let idx = 0;
  MIN_REVIEW_STEPS.forEach((v, i) => {
    if (v <= minReviews) idx = i;
  });
  return idx;
}

function currentConfig() {
  return {
    ...ML.BAYES_DEFAULTS,
    priorMean: parseFloat($("priorMean").value),
    priorWeight: parseInt($("priorWeight").value, 10),
    minReviews: MIN_REVIEW_STEPS[parseInt($("minReviews").value, 10)] ?? 0,
  };
}

// O que está salvo agora — para o botão Salvar só acender quando houver mudança.
let saved = null;

const sameConfig = (a, b) =>
  !!a && !!b && a.priorMean === b.priorMean && a.priorWeight === b.priorWeight && a.minReviews === b.minReviews;

// Preenche a trilha do slider até o thumb (o range nativo não faz isso sozinho).
function paintTrack(input) {
  const min = Number(input.min);
  const pct = ((Number(input.value) - min) / (Number(input.max) - min)) * 100;
  input.style.setProperty("--fill", `${pct}%`);
}

function render() {
  const cfg = currentConfig();
  $("priorMeanOut").textContent = fmt(cfg.priorMean);
  $("priorWeightOut").textContent = String(cfg.priorWeight);
  $("minReviewsOut").textContent = cfg.minReviews ? String(cfg.minReviews) : "—";
  paintTrack($("priorMean"));
  paintTrack($("priorWeight"));
  paintTrack($("minReviews"));
  $("save").disabled = sameConfig(cfg, saved);

  // Reordena de fato: arrastar "avaliações para confiar" para baixo faz o 5,0 com 3
  // avaliações subir ao topo, que é exatamente o erro que o score corrige.
  const rows = EXAMPLES.map((e) => ({ ...e, score: ML.bayesianScore100(e.rating, e.count, cfg) })).sort(
    (a, b) => b.score - a.score
  );

  // Abaixo do mínimo de avaliações: vai para o fim, sem posição — como na busca.
  rows.sort((a, b) => (a.count < cfg.minReviews) - (b.count < cfg.minReviews));
  let rank = 0;
  $("examples").innerHTML = rows
    .map((r) => {
      const hidden = r.count < cfg.minReviews;
      return `<div class="p-row${hidden ? " p-row--hidden" : ""}">
           <span class="p-rank">${hidden ? "–" : ++rank}</span>
           <span class="p-desc"><b>★ ${fmt(r.rating)}</b> <span>· ${r.count.toLocaleString("pt-BR")} avaliações</span></span>
           ${
             hidden
               ? '<span class="p-score p-score--hidden">oculto</span>'
               : `<span class="p-score" style="background:${ML.scoreColor(r.score)}">${ML.formatNumber(r.score)}</span>`
           }
         </div>`;
    })
    .join("");
}

function apply(cfg) {
  $("priorMean").value = cfg.priorMean;
  $("priorWeight").value = cfg.priorWeight;
  $("minReviews").value = stepIndex(cfg.minReviews);
  render();
}

async function load() {
  let config = null;
  // Se o storage falhar, o popup ainda abre nos padrões — melhor que sliders vazios
  // e prévia em branco, que é o que acontece se render() nunca rodar.
  try {
    ({ config } = await chrome.storage.local.get("config"));
  } catch (_) {}
  apply(ML.sanitizeConfig(config));
  saved = currentConfig();
  render();
}

let statusTimer = null;
function showStatus(text) {
  const s = $("status");
  s.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (s.textContent = ""), 2500);
}

// As buscas abertas escutam o storage e recalculam na hora — sem recarregar a aba, o
// que perderia as páginas somadas e a ordenação escolhida.
async function save() {
  const { priorMean, priorWeight, minReviews } = currentConfig();
  try {
    await chrome.storage.local.set({ config: { priorMean, priorWeight, minReviews } });
  } catch (err) {
    showStatus(`Não foi possível salvar: ${err?.message || err}`);
    return;
  }
  saved = currentConfig();
  render();
  showStatus("Salvo. As buscas abertas já foram atualizadas.");
}

// ---- cache -----------------------------------------------------------------
async function showCache() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "cacheStats" });
    const n = resp?.ok ? resp.count : 0;
    $("cacheInfo").textContent =
      n === 0 ? "Cache vazio" : `${n.toLocaleString("pt-BR")} ${n === 1 ? "anúncio" : "anúncios"} em cache (24h)`;
    $("clearCache").disabled = n === 0;
  } catch (_) {
    $("cacheInfo").textContent = "Cache indisponível";
    $("clearCache").disabled = true;
  }
}

async function clearCache() {
  $("clearCache").disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "clearCache" });
    showStatus(resp?.ok ? "Cache limpo. As próximas buscas leem tudo de novo." : "Não foi possível limpar o cache.");
  } catch (_) {
    showStatus("Não foi possível limpar o cache.");
  }
  showCache();
}

["priorMean", "priorWeight", "minReviews"].forEach((id) => $(id).addEventListener("input", render));
$("save").addEventListener("click", save);
$("clearCache").addEventListener("click", clearCache);
$("reset").addEventListener("click", () => {
  apply(ML.BAYES_DEFAULTS);
  $("status").textContent = "";
});

load();
showCache();
