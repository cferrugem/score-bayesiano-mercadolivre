import assert from "node:assert/strict";
import { test } from "node:test";
import "../../src/bayes.js";

const ML = globalThis.MLScore;

test("reproduz o exemplo do README: 4,7/9313 vence 5,0/3", () => {
  assert.equal(ML.bayesianScore100(4.7, 9313), 94);
  assert.equal(ML.bayesianScore100(5.0, 3), 87.3);
  assert.ok(ML.bayesianScore100(4.7, 9313) > ML.bayesianScore100(5.0, 3));
});

test("sem avaliações o score é o prior; com muitas, tende à nota", () => {
  const cfg = { ...ML.BAYES_DEFAULTS, priorMean: 4, priorWeight: 10 };
  assert.equal(ML.bayesianScore(5, 0, cfg), 4);
  assert.ok(Math.abs(ML.bayesianScore(5, 1e7, cfg) - 5) < 1e-4);
});

test("nota ausente não vira zero", () => {
  assert.equal(ML.bayesianScore(null, 100), null);
  assert.equal(ML.bayesianScore(undefined, 100), null);
  assert.equal(ML.bayesianScore("abc", 100), null);
  assert.equal(ML.bayesianScore100(null, 100), null);
});

test("sanitizeConfig descarta valores fora dos limites ou inválidos", () => {
  assert.deepEqual(ML.sanitizeConfig(undefined), ML.BAYES_DEFAULTS);
  assert.deepEqual(ML.sanitizeConfig({ priorMean: "x", priorWeight: -3, minReviews: null }), ML.BAYES_DEFAULTS);
  const cfg = ML.sanitizeConfig({ priorMean: 4.5, priorWeight: 50, minReviews: 10, maxStars: 99 });
  assert.equal(cfg.priorMean, 4.5);
  assert.equal(cfg.priorWeight, 50);
  assert.equal(cfg.minReviews, 10);
  assert.equal(cfg.maxStars, 5, "maxStars não é configurável");
});

test("custo-benefício: o melhor da página vale 100 e sem preço fica de fora", () => {
  const raws = [ML.valueRaw(90, 100), ML.valueRaw(90, 50), ML.valueRaw(90, null), ML.valueRaw(null, 10)];
  assert.deepEqual(ML.normalizeValues(raws), [50, 100, null, null]);
  assert.deepEqual(ML.normalizeValues([null, null]), [null, null]);
});

test("formatação pt-BR", () => {
  assert.equal(ML.formatNumber(87.3), "87,3");
  assert.equal(ML.formatNumber(94), "94");
  assert.equal(ML.formatNumber(9313, 0), "9.313");
  assert.equal(ML.formatNumber(null), "—");
});

test("cores das faixas têm contraste AA com texto branco", () => {
  const lum = (hex) => {
    const c = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  for (const score of [95, 85, 75, 50, null]) {
    const ratio = 1.05 / (lum(ML.scoreColor(score)) + 0.05);
    assert.ok(ratio >= 4.5, `score ${score}: contraste ${ratio.toFixed(2)}`);
  }
});
