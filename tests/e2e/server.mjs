// Servidor HTTPS local que faz o papel do Mercado Livre nos testes ponta a ponta.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { PAGE_PATHS, productPage, searchPage } from "./fixtures.mjs";

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "mlscore-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=*.mercadolivre.com.br", "-keyout", key, "-out", cert],
    { stdio: "ignore" }
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// Sobe o servidor e devolve { port, hits, close }. `hits` registra cada pedido de
// página de detalhe (para verificar cache e que links de anúncio não são seguidos).
export async function startServer() {
  const hits = [];
  const pages = Object.fromEntries(Object.entries(PAGE_PATHS).map(([n, p]) => [p, Number(n)]));
  const server = https.createServer(selfSignedCert(), (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const host = url.hostname;
    const html = (body, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };

    if (host.startsWith("click")) {
      hits.push({ kind: "click", path: url.pathname });
      return html("clique de anúncio", 200);
    }
    if (host === "lista.mercadolivre.com.br" && url.pathname in pages) {
      return html(searchPage(pages[url.pathname]));
    }
    if (host === "produto.mercadolivre.com.br") {
      const m = url.pathname.match(/MLB-(\d+)/);
      const id = m && `MLB${m[1]}`;
      hits.push({ kind: "product", id });
      const body = id && productPage(id);
      return body ? html(body) : html("não encontrado", 404);
    }
    html("não encontrado", 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits, close: () => server.close() };
}
