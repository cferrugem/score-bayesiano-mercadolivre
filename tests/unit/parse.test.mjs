import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeProductPage, parseDetail, parseSold } from "../../src/parse.js";

// Trecho no formato da página de detalhe real do ML.
const PDP = `
<h1 class="ui-pdp-title">Calça Jeans</h1>
<span class="ui-pdp-subtitle">Novo  |  +10 mil vendidos</span>
<span class="ui-pdp-review__rating" aria-hidden="true">4.7</span>
<span class="ui-pdp-review__amount">(9.313)</span>
${[78, 12, 5, 2, 3]
  .map((w) => `<span class="ui-review-capability-rating__level__progress-bar__fill-background" style="width: ${w}%"></span>`)
  .join("")}`;

test("lê nota, nº de avaliações, distribuição e vendas do markup", () => {
  assert.deepEqual(parseDetail(PDP), {
    rating: 4.7,
    count: 9313,
    dist: [78, 12, 5, 2, 3],
    sold: { text: "+10 mil", num: 10000 },
  });
});

test("cai para o JSON-LD quando o markup visível muda", () => {
  const html = `<div class="nova-classe">4,6</div>
    <script type="application/ld+json">{"@type":"Product","name":"X",
      "aggregateRating":{"@type":"AggregateRating","ratingValue":4.6,"reviewCount":"1520"}}</script>`;
  const r = parseDetail(html);
  assert.equal(r.rating, 4.6);
  assert.equal(r.count, 1520);
  assert.ok(looksLikeProductPage(html));
});

test("o markup tem prioridade sobre o JSON-LD", () => {
  const html = PDP + '<script>{"aggregateRating":{"ratingValue":"3.0","ratingCount":"5"}}</script>';
  const r = parseDetail(html);
  assert.equal(r.rating, 4.7);
  assert.equal(r.count, 9313);
});

test("anúncio sem avaliações: tudo nulo, mas ainda é página de produto", () => {
  const html = '<h1 class="ui-pdp-title">Novo</h1><span class="ui-pdp-subtitle">Novo</span>';
  assert.deepEqual(parseDetail(html), { rating: null, count: null, dist: null, sold: null });
  assert.ok(looksLikeProductPage(html));
});

test("captcha/erro não parece página de produto", () => {
  assert.equal(looksLikeProductPage("<html><body>Verifique que você não é um robô</body></html>"), false);
});

test("vendas em todos os formatos do subtítulo", () => {
  assert.deepEqual(parseSold("Novo  |  +10 mil vendidos"), { text: "+10 mil", num: 10000 });
  assert.deepEqual(parseSold("Novo | +1,5 mil vendidos"), { text: "+1,5 mil", num: 1500 });
  assert.deepEqual(parseSold("Usado | +1.000 vendidos"), { text: "+1.000", num: 1000 });
  assert.deepEqual(parseSold("+5 vendidos"), { text: "+5", num: 5 });
  assert.deepEqual(parseSold("Novo | 1 vendido"), { text: "1", num: 1 });
  assert.deepEqual(parseSold("Novo | +2 milhões vendidos"), { text: "+2 milhões", num: 2e6 });
  assert.equal(parseSold("Novo"), null);
  assert.equal(parseSold(null), null);
});
