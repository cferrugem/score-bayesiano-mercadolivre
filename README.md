# Score Bayesiano — Mercado Livre

Extensão de navegador (Chrome/Edge, Manifest V3) que calcula um **score bayesiano** para os
produtos da busca do Mercado Livre e permite ordenar os resultados por ele.

## Por que "bayesiano"?

A nota simples engana: um produto com **5,0 e 3 avaliações** aparenta ser melhor que um com
**4,7 e 9.313 avaliações** — mas não é. O score bayesiano corrige isso com um encolhimento
(*shrinkage*) em direção à média do nicho, proporcional à quantidade de avaliações:

```
score = (C·m + n·R) / (C + n)
```

| símbolo | significado | padrão |
|---|---|---|
| `R` | nota média do produto | — |
| `n` | número de avaliações | — |
| `m` | média global do nicho (prior) | 4.3 |
| `C` | peso do prior (avaliações "fictícias") | 30 |

Exemplo real (validado): `4.7 / 9313 → 94` &nbsp;vs&nbsp; `5.0 / 3 → 87.3`.

## Como funciona

O Mercado Livre **não mostra o número de avaliações na página de busca** (só a nota e a
quantidade vendida). Então, para cada card, a extensão:

1. lê a nota, o **preço atual** e o link do produto no card;
2. pede ao *service worker* que **baixe a página de detalhe em segundo plano** (com fila e
   limite de concorrência) e extraia nota + nº de avaliações + distribuição de estrelas;
3. injeta **quatro badges** no card:
   - **Qualidade** — o score bayesiano (0–100), colorido por faixa;
   - **C/B (custo-benefício)** — qualidade por real, normalizado de 0 a 100 **dentro da
     página** (o melhor negócio da página = 100). É um eixo separado: preço não contamina o
     score de qualidade;
   - **⭐ avaliações** — o número **exato** de avaliações (ex.: `5.111`), lido da **página de
     detalhe** (a busca não expõe esse número);
   As **vendas** (quantidade vendida em faixa, ex.: `+10mil`) também são lidas do **subtítulo
   do detalhe** — não da busca, cujo número costuma agregar o catálogo inteiro (todos os
   vendedores) e engana. Não viram badge (o card do ML já mostra "+N vendidos"), mas
   alimentam a ordenação.
4. uma **barra de controle** no topo da coluna de resultados, fixa ao rolar, com todos os
   critérios de ordenação visíveis: Relevância (padrão), Qualidade, Custo-benefício,
   Avaliações, Vendas | Menor preço, Maior preço. Ela também mostra quantos anúncios já
   foram pontuados — enquanto o contador não fecha, ordenar por qualidade, custo-benefício,
   avaliações ou vendas usa uma página incompleta.

Os resultados ficam em cache por 24h (`chrome.storage.local`).

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione a pasta `extensao/`.
4. Abra uma busca, ex.: <https://lista.mercadolivre.com.br/calca>.

Ajuste `m` e `C` no ícone da extensão (popup).

## Estrutura

```
extensao/
├─ manifest.json
├─ src/
│  ├─ bayes.js        # fórmula do score (content script)
│  ├─ content.js      # lê cards, injeta badges, ordena
│  ├─ background.js   # fetch da página de detalhe + parsing (regex) + cache/fila
│  └─ styles.css
└─ popup/             # configuração de m e C
```

## Limitações conhecidas (v0.1)

- **API de reviews do ML está fechada (403)** — por isso o parsing é feito sobre o HTML de
  detalhe. Se o ML mudar as classes (`ui-pdp-review__rating`, `ui-pdp-review__amount`,
  `ui-review-capability-rating__level__progress-bar__fill-background`), o parser precisa de ajuste.
- Cards **patrocinados** são resolvidos seguindo o redirect `click1.mercadolivre.com.br`, o que
  contabiliza um clique de anúncio. Melhoria futura: construir a URL canônica a partir do MLB id.
- Baixar N páginas de detalhe é mais lento e pode sofrer *rate limit*; a fila usa concorrência 4
  com respiro de 120 ms.
- Ainda **só Mercado Livre**. Amazon exige capturar as páginas equivalentes e escrever um adaptador.
```
