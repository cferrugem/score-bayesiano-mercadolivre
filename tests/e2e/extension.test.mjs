// Teste ponta a ponta: Chromium real com a extensão carregada, contra um "Mercado Livre"
// local (tests/e2e/server.mjs). Os testes deste arquivo rodam em sequência e dividem o
// mesmo navegador — o cache do primeiro é o que o segundo verifica, por exemplo.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch } from "./browser.mjs";
import { startServer } from "./server.mjs";

const SEARCH = "https://lista.mercadolivre.com.br/calca";

let srv, context, worker, extensionId, page, baseTabs;
const errors = [];

before(async () => {
  srv = await startServer();
  ({ context, worker, extensionId } = await launch(srv.port));
  page = await context.newPage();
  baseTabs = context.pages().length; // o contexto persistente já abre uma aba em branco
  page.on("pageerror", (e) => errors.push(e.message));
});

after(async () => {
  await context?.close();
  srv?.close();
});

// Espera todos os cards de produto terem resposta do detalhe.
async function waitScored(expected) {
  await page.waitForFunction(
    (n) => {
      const done = document.querySelectorAll("li.ui-search-layout__item[data-mlscore]");
      return done.length === n && document.getElementById("mlscore-toolbar")?.classList.contains("mlscore-bar--ready");
    },
    expected,
    { timeout: 15000 }
  );
  // O refresh é agrupado (80 ms); dá tempo de ele assentar.
  await page.waitForTimeout(200);
}

const cardsInfo = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("li.ui-search-layout__item")].map((li) => ({
      id: li.querySelector("a.poly-component__title")?.textContent.replace("Calça ", "") ?? null,
      badges: li.querySelector(".mlscore-wrap")?.innerText.split("\n").filter(Boolean) ?? null,
      hidden: li.classList.contains("mlscore-hidden"),
    }))
  );

const productHits = () => srv.hits.filter((h) => h.kind === "product").length;

test("pontua os cards de produto e ignora slots de publicidade", async () => {
  await page.goto(SEARCH);
  await waitScored(5);
  const cards = await cardsInfo();

  const ad = cards.find((c) => c.id === null);
  assert.ok(ad, "o fixture tem um slot de publicidade");
  assert.equal(ad.badges, null, "slot de publicidade não ganha badge");

  const by = Object.fromEntries(cards.filter((c) => c.id).map((c) => [c.id, c.badges]));
  assert.deepEqual(by.MLB1000002, ["Qualidade 94", "C/B 52", "9.313 aval."]);
  assert.deepEqual(by.MLB1000001, ["Qualidade 87,3", "C/B 69", "3 aval."]);
  assert.deepEqual(by.MLB1000003, ["Qualidade 84,5", "C/B 100", "86 aval."]);
  assert.deepEqual(by.MLB1000004, ["sem avaliações", "C/B —", "0 aval."]);

  const meter = await page.textContent("#mlscore-meter");
  assert.equal(meter, "5 anúncios pontuados");
  assert.deepEqual(errors, []);
});

test("link patrocinado é resolvido sem registrar clique de anúncio", () => {
  assert.equal(srv.hits.filter((h) => h.kind === "click").length, 0);
  assert.ok(srv.hits.some((h) => h.id === "MLB1000003"), "o patrocinado foi lido pelo detalhe");
});

test("a barra usa a tipografia definida (regressão do `font: … inherit`)", async () => {
  const style = await page.evaluate(() => {
    const pill = getComputedStyle(document.querySelector(".mlscore-pill"));
    const name = getComputedStyle(document.querySelector(".mlscore-bar__name"));
    return { pill: [pill.fontSize, pill.fontWeight], name: [name.fontSize, name.fontWeight] };
  });
  assert.deepEqual(style.pill, ["12.5px", "600"]);
  assert.deepEqual(style.name, ["12px", "700"]);
});

test("ordena por qualidade e lembra a escolha ao recarregar", async () => {
  await page.click('.mlscore-pill[data-mode="quality"]');
  const order = async () => (await cardsInfo()).filter((c) => c.id).map((c) => c.id);
  const expected = ["MLB1000005", "MLB1000002", "MLB1000001", "MLB1000003", "MLB1000004"];
  assert.deepEqual(await order(), expected);
  assert.equal(await page.getAttribute('.mlscore-pill[data-mode="quality"]', "aria-pressed"), "true");

  const hitsBefore = productHits();
  await page.reload();
  await waitScored(5);
  assert.deepEqual(await order(), expected, "a ordenação salva é reaplicada");
  assert.equal(await page.getAttribute('.mlscore-pill[data-mode="quality"]', "aria-pressed"), "true");
  // Tudo veio do cache, inclusive o anúncio sem avaliações (cache negativo).
  assert.equal(productHits(), hitsBefore, "nenhuma página de detalhe foi baixada de novo");

  await page.click('.mlscore-pill[data-mode="rel"]');
});

test("mudança de config vale na hora, sem recarregar a aba", async () => {
  await worker.evaluate(() => chrome.storage.local.set({ config: { priorMean: 4.3, priorWeight: 1, minReviews: 0 } }));
  await page.waitForFunction(() => document.body.innerText.includes("Qualidade 96,5"), null, { timeout: 5000 });
  // Com C = 1 a nota de 5,0 com 3 avaliações fica em (4,3 + 3·5)/4 = 4,825.
  const by = Object.fromEntries((await cardsInfo()).filter((c) => c.id).map((c) => [c.id, c.badges[0]]));
  assert.equal(by.MLB1000001, "Qualidade 96,5");

  await worker.evaluate(() => chrome.storage.local.set({ config: { priorMean: 4.3, priorWeight: 30, minReviews: 10 } }));
  await page.waitForFunction(() => document.querySelectorAll("li.mlscore-hidden").length === 2, null, {
    timeout: 5000,
  });
  const hidden = (await cardsInfo()).filter((c) => c.hidden).map((c) => c.id).sort();
  assert.deepEqual(hidden, ["MLB1000001", "MLB1000004"]);
  assert.match(await page.textContent("#mlscore-meter"), /2 ocultos \(menos de 10 aval\.\)/);

  await worker.evaluate(() => chrome.storage.local.set({ config: { priorMean: 4.3, priorWeight: 30, minReviews: 0 } }));
  await page.waitForFunction(() => !document.querySelector("li.mlscore-hidden"), null, { timeout: 5000 });
});

test("+ Página 2 soma os anúncios, sem repetir, e fecha a aba de colheita", async () => {
  assert.equal(await page.textContent("#mlscore-more"), "+ Página 2");
  await page.click("#mlscore-more");
  // 5 da página 1 + 2 novos da página 2 (MLB1000002 repete e é descartado).
  await waitScored(7);
  const ids = (await cardsInfo()).filter((c) => c.id).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "sem anúncios repetidos");
  assert.ok(ids.includes("MLB2000001") && ids.includes("MLB2000002"));

  assert.equal(await page.textContent("#mlscore-meter"), "7 anúncios pontuados · páginas 1–2");
  assert.equal(await page.textContent("#mlscore-more"), "+ Página 3");

  // Paginação do rodapé: 1 e 2 viram marcadores; os links seguem a partir da 3.
  const pager = await page.evaluate(() =>
    [...document.querySelectorAll("ul.andes-pagination li")].map((li) => [
      li.textContent.trim(),
      li.querySelector("a")?.getAttribute("href") ?? null,
    ])
  );
  assert.deepEqual(pager, [
    ["1", null],
    ["2", null],
    ["3", "https://lista.mercadolivre.com.br/calca_Desde_97_NoIndex_True"],
    ["Seguinte", "https://lista.mercadolivre.com.br/calca_Desde_97_NoIndex_True"],
  ]);

  // A aba de colheita não fica aberta.
  await page.waitForTimeout(300);
  assert.equal(context.pages().length, baseTabs);
  assert.deepEqual(errors, []);
});

test("página seguinte sem anúncios novos mostra aviso e não trava o botão", async () => {
  await page.click("#mlscore-more"); // página 3 do fixture está vazia
  await page.waitForFunction(
    () => document.getElementById("mlscore-meter").classList.contains("mlscore-bar__meter--warn"),
    null,
    { timeout: 15000 }
  );
  assert.equal(await page.isDisabled("#mlscore-more"), false);
  assert.equal(context.pages().length, baseTabs);
});

test("popup: prévia, salvar só com mudança, e cache", async () => {
  const popup = await context.newPage();
  popup.on("pageerror", (e) => errors.push(`popup: ${e.message}`));
  popup.on("console", (m) => m.type() === "error" && errors.push(`popup: ${m.text()}`));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll(".p-row").length === 3);

  assert.equal(await popup.isDisabled("#save"), true, "nada mudou ainda");
  assert.match(await popup.textContent("#cacheInfo"), /^\d+ anúncios em cache/);

  // Mínimo de 10 avaliações: o exemplo com 3 avaliações vira "oculto" na prévia.
  await popup.$eval("#minReviews", (el) => {
    el.value = "2";
    el.dispatchEvent(new Event("input"));
  });
  assert.equal(await popup.textContent("#minReviewsOut"), "10");
  assert.equal(await popup.locator(".p-row--hidden").count(), 1, await popup.innerHTML("#examples"));
  assert.equal(await popup.isDisabled("#save"), false);

  await popup.click("#save");
  const saved = await worker.evaluate(() => chrome.storage.local.get("config"));
  assert.deepEqual(saved.config, { priorMean: 4.3, priorWeight: 30, minReviews: 10 });
  assert.equal(await popup.isDisabled("#save"), true);

  assert.deepEqual(errors, []);

  await popup.click("#clearCache");
  await popup.waitForFunction(() => document.getElementById("cacheInfo").textContent === "Cache vazio");
  await popup.close();
});
