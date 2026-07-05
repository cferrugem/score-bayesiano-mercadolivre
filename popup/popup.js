const DEFAULTS = { priorMean: 4.3, priorWeight: 30 };

const $ = (id) => document.getElementById(id);

async function load() {
  const { config } = await chrome.storage.local.get("config");
  const cfg = { ...DEFAULTS, ...(config || {}) };
  $("priorMean").value = cfg.priorMean;
  $("priorWeight").value = cfg.priorWeight;
}

async function save() {
  const config = {
    priorMean: parseFloat($("priorMean").value) || DEFAULTS.priorMean,
    priorWeight: parseFloat($("priorWeight").value) || DEFAULTS.priorWeight,
  };
  await chrome.storage.local.set({ config });
  const s = $("status");
  s.textContent = "Salvo! Recarregue a busca.";
  setTimeout(() => (s.textContent = ""), 2500);
}

$("save").addEventListener("click", save);
load();
