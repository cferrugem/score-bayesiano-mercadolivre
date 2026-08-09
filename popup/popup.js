// Popup de configuração. Reaproveita src/bayes.js — os números e as cores da prévia
// são calculados exatamente pela mesma função que roda nos cards da busca.
// NÃO desestruturar: bayes.js é um script clássico e compartilha o escopo léxico desta
// página, então `const { BAYES_DEFAULTS } = ...` colidiria com a const homônima de lá
// ("Identifier already declared") e derrubaria todo o popup — igual ao content.js.
const ML = self.MLScore;

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 1) => n.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

// Casos que mostram o que o prior faz. O primeiro é a armadilha que a extensão existe
// para desarmar: nota cheia com pouquíssimas avaliações.
const EXAMPLES = [
  { rating: 5.0, count: 3 },
  { rating: 4.7, count: 9313 },
  { rating: 4.2, count: 86 },
];

function currentConfig() {
  return {
    ...ML.BAYES_DEFAULTS,
    priorMean: parseFloat($("priorMean").value),
    priorWeight: parseInt($("priorWeight").value, 10),
  };
}

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
  paintTrack($("priorMean"));
  paintTrack($("priorWeight"));

  // Reordena de fato: arrastar "avaliações para confiar" para baixo faz o 5,0 com 3
  // avaliações subir ao topo, que é exatamente o erro que o score corrige.
  const rows = EXAMPLES.map((e) => ({ ...e, score: ML.bayesianScore100(e.rating, e.count, cfg) })).sort(
    (a, b) => b.score - a.score
  );

  $("examples").innerHTML = rows
    .map(
      (r, i) =>
        `<div class="p-row">
           <span class="p-rank">${i + 1}</span>
           <span class="p-desc"><b>★ ${fmt(r.rating)}</b> <span>· ${r.count.toLocaleString("pt-BR")} avaliações</span></span>
           <span class="p-score" style="background:${ML.scoreColor(r.score)}">${fmt(r.score)}</span>
         </div>`
    )
    .join("");
}

function apply(cfg) {
  $("priorMean").value = cfg.priorMean;
  $("priorWeight").value = cfg.priorWeight;
  render();
}

async function load() {
  let config = null;
  // Se o storage falhar, o popup ainda abre nos padrões — melhor que sliders vazios
  // e prévia em branco, que é o que acontece se render() nunca rodar.
  try {
    ({ config } = await chrome.storage.local.get("config"));
  } catch (_) {}
  apply({ ...ML.BAYES_DEFAULTS, ...(config || {}) });
}

// Recarrega a aba da busca para o novo cálculo valer — sem isso o usuário salva e
// não vê nada mudar. Só age em páginas do Mercado Livre.
async function reloadSearchTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/mercadoli(v|b)re\./.test(tab.url || "")) return false;
    await chrome.tabs.reload(tab.id);
    return true;
  } catch (_) {
    return false;
  }
}

async function save() {
  const { priorMean, priorWeight } = currentConfig();
  await chrome.storage.local.set({ config: { priorMean, priorWeight } });
  const reloaded = await reloadSearchTab();
  const s = $("status");
  s.textContent = reloaded ? "Salvo. Busca recarregada." : "Salvo. Recarregue a busca para aplicar.";
  setTimeout(() => (s.textContent = ""), 2500);
}

["priorMean", "priorWeight"].forEach((id) => $(id).addEventListener("input", render));
$("save").addEventListener("click", save);
$("reset").addEventListener("click", () => {
  apply(ML.BAYES_DEFAULTS);
  $("status").textContent = "";
});

load();
