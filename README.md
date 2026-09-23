<img src="icons/logo.svg" width="72" alt="">

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
3. injeta **três badges** no card (slots de publicidade sem produto ficam de fora):
   - **Qualidade** — o score bayesiano (0–100), colorido por faixa;
   - **C/B (custo-benefício)** — qualidade por real, normalizado de 0 a 100 **dentro da
     página** (o melhor negócio da página = 100). É um eixo separado: preço não contamina o
     score de qualidade;
   - **avaliações** — o número **exato** de avaliações (ex.: `5.111 aval.`), lido da
     **página de detalhe** (a busca não expõe esse número);
   As **vendas** (quantidade vendida em faixa, ex.: `+10mil`) também são lidas do **subtítulo
   do detalhe** — não da busca, cujo número costuma agregar o catálogo inteiro (todos os
   vendedores) e engana. Não viram badge (o card do ML já mostra "+N vendidos"), mas
   alimentam a ordenação.
4. uma **barra de controle** no topo da coluna de resultados, fixa ao rolar, com todos os
   critérios de ordenação visíveis: Relevância (padrão), Qualidade, Custo-benefício,
   Avaliações, Vendas | Menor preço, Maior preço. Ela também mostra quantos anúncios já
   foram pontuados — enquanto o contador não fecha, ordenar por qualidade, custo-benefício,
   avaliações ou vendas usa uma página incompleta. A ordenação escolhida fica salva e vale
   para as próximas buscas.
5. um botão **"+ Página N"** que soma a próxima página de resultados à mesma tela, até
   três páginas. A ordenação e o custo-benefício passam a valer sobre o conjunto inteiro,
   e a paginação do rodapé é reescrita para seguir a partir da primeira página ainda não
   carregada.

Os resultados ficam em cache por 24h (`chrome.storage.local`); anúncios sem avaliação, por
6h. Entradas vencidas são apagadas quando o navegador inicia, e o popup mostra o tamanho do
cache e permite limpá-lo. Se o markup visível da página de detalhe mudar, a nota e o nº de
avaliações ainda são lidos do JSON-LD (`aggregateRating`) que o ML embute para buscadores.

### Por que "+ Página N" abre uma aba

O grid de resultados do Mercado Livre é renderizado no cliente, e não há atalho para isso:

| tentativa | resultado |
| --- | --- |
| `fetch` + `DOMParser` | 0 cards — o HTML cru não traz o grid, nem o da página já aberta |
| iframe (oculto ou visível) | 0 cards — com `window.top !== self` o app só monta o cabeçalho |
| `api.mercadolibre.com` | 403 |

Uma aba de verdade, mesmo inativa e com `visibilityState: "hidden"`, renderiza tudo. Então
o botão abre a página seguinte numa aba em segundo plano, o content script de lá devolve os
cards já prontos e a aba se fecha. Os cards são os nativos do ML, não uma reconstrução.

Cada página traz ~60 `<li>` para 48 produtos, e os slots de anúncio repetem itens — na
medição, **20 dos 60** cards da página 2 já estavam na página 1. Por isso o merge deduplica
por MLB id.

## Instalação (modo desenvolvedor)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ative **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione a pasta raiz deste repositório (a que tem o
   `manifest.json`).
4. Abra uma busca, ex.: <https://lista.mercadolivre.com.br/calca>.

Ajuste `m` e `C` no ícone da extensão. O popup mostra, ao vivo, como três anúncios de
exemplo são pontuados e reordenados a cada mudança — arraste **Avaliações para confiar**
até o mínimo e veja o "5,0 com 3 avaliações" saltar para o primeiro lugar, que é
exatamente o erro que o score existe para corrigir.

**Esconder com menos de** tira da busca os anúncios com poucas avaliações (0, 5, 10, 25,
50, 100, 250 ou 500); a barra diz quantos ficaram ocultos.

Ao **Salvar**, as buscas abertas recalculam na hora — sem recarregar a aba, então as
páginas somadas e a ordenação continuam lá.

## Testes

```
npm install
npm test          # unitários: fórmula, config, parser do detalhe (node:test)
npm run test:e2e  # ponta a ponta: Chromium real com a extensão carregada
```

O teste ponta a ponta sobe um servidor HTTPS local que imita a busca e as páginas de
detalhe do ML (`tests/e2e/fixtures.mjs`) e faz o Chromium resolver `*.mercadolivre.com.br`
para ele. Verifica badges, ordenação e a memória dela, cache, config ao vivo, o filtro de
avaliações, "+ Página N" (dedupe e paginação reescrita) e o popup. Precisa de `openssl` e
do Chromium do Playwright. Os fixtures seguem o markup que os seletores esperam — não
substituem conferir, de vez em quando, numa busca de verdade.

## Estrutura

```
.
├─ manifest.json
├─ src/
│  ├─ bayes.js        # fórmula do score, config e formatação (content script + popup)
│  ├─ pages.js        # URLs das páginas + modo colheita (aba em segundo plano)
│  ├─ content.js      # lê cards, injeta badges, ordena, filtra, funde páginas
│  ├─ background.js   # fetch da página de detalhe + cache/fila/retry
│  │                  # + abre/fecha a aba de colheita
│  ├─ parse.js        # parsing (regex + JSON-LD) do HTML de detalhe
│  └─ styles.css
├─ popup/             # m, C, mínimo de avaliações e cache
├─ icons/             # logo.svg + PNGs (npm run icons)
└─ tests/
   ├─ unit/           # node --test
   └─ e2e/            # Playwright + servidor HTTPS falso do ML
```

## Limitações conhecidas (v0.2)

- **API de reviews do ML está fechada (403)** — por isso o parsing é feito sobre o HTML de
  detalhe. Se o ML mudar as classes (`ui-pdp-review__rating`, `ui-pdp-review__amount`,
  `ui-review-capability-rating__level__progress-bar__fill-background`), o parser precisa de ajuste.
- Cards **patrocinados** usam o destino real embutido no link (`urldest`), sem passar pelo
  `click1.mercadolivre.com.br` — nenhum clique de anúncio é contabilizado. Se o link não
  trouxer `urldest`, a extensão monta a URL canônica `produto.mercadolivre.com.br/MLB-<id>`;
  esse caminho ainda não foi conferido contra o site real.
- Baixar N páginas de detalhe é mais lento e pode sofrer *rate limit*; a fila usa concorrência 4
  com respiro de 120 ms, e respostas 429/5xx são repetidas até 2 vezes com espera crescente.
