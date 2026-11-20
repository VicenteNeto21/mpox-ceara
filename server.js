const http = require("http");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const PORT = Number(process.env.PORT || 5500);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const UPSTREAM_API = "https://apidadosabertos.saude.gov.br/vigilancia-e-meio-ambiente/mpox";
const MPX_2026_ZIP = "https://s3.sa-east-1.amazonaws.com/ckan.saude.gov.br/mpox/csv/MPX_2026_OPENDATASUS.csv.zip";
const IBGE_CEARA_API = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/23/municipios";
const INTEGRASUS_CSV = "https://datasets-integrasus.saude.ce.gov.br/datasets/download/33";
const INTEGRASUS_DASH_BASE = "https://integrasus.saude.ce.gov.br/api/monkeypox";
const ROOT = __dirname;

let municipalitiesCache = null;
let municipalitiesCacheTime = 0;
let mpox2026Cache = null;
let mpox2026CacheTime = 0;

const CEARA_MUNICIPALITY_FALLBACK = [
  { id: 2304400, nome: "Fortaleza" }, { id: 2303709, nome: "Caucaia" },
  { id: 2311801, nome: "Russas" }, { id: 2312908, nome: "Sobral" },
  { id: 2307304, nome: "Juazeiro do Norte" }, { id: 2306256, nome: "Itaitinga" },
  { id: 2308203, nome: "Meruoca" }, { id: 2310506, nome: "Pedra Branca" },
  { id: 2307650, nome: "Maracanaú" }, { id: 2301000, nome: "Aquiraz" },
  { id: 2307809, nome: "Marco" }, { id: 2305233, nome: "Horizonte" },
  { id: 2307635, nome: "Madalena" }, { id: 2307700, nome: "Maranguape" },
  { id: 2313302, nome: "Tauá" }, { id: 2312601, nome: "São Luís do Curu" },
  { id: 2310803, nome: "Pereiro" }, { id: 2312403, nome: "São Gonçalo do Amarante" }
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(value));
}

// Proxy para os endpoints oficiais do Dashboard IntegraSUS
async function proxyIntegraDashboard(request, response, subpath) {
  const reqUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const targetUrl = new URL(`${INTEGRASUS_DASH_BASE}/${subpath}`);
  reqUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    if (upstream.ok) {
      const data = await upstream.text();
      response.writeHead(upstream.status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      response.end(data);
      return;
    }
  } catch (e) {
    console.warn(`Erro no proxy dashboard ${subpath}:`, e.message);
  }

  // Fallback para snapshot local
  const localFile = path.join(ROOT, "data", "integrasus-dashboard.json");
  if (fs.existsSync(localFile)) {
    try {
      const dash = JSON.parse(fs.readFileSync(localFile, "utf8"));
      if (dash[subpath]) {
        sendJson(response, 200, dash[subpath]);
        return;
      }
    } catch (e) {}
  }
  sendJson(response, 502, { error: "Serviço do IntegraSUS temporariamente indisponível." });
}

async function proxyCearaMunicipalities(response) {
  const now = Date.now();
  if (municipalitiesCache && now - municipalitiesCacheTime < 24 * 60 * 60 * 1000) {
    sendJson(response, 200, municipalitiesCache);
    return;
  }

  const localFile = path.join(ROOT, "data", "municipios-ceara.json");
  if (fs.existsSync(localFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(localFile, "utf8"));
      municipalitiesCache = data;
      municipalitiesCacheTime = now;
      sendJson(response, 200, data);
      return;
    } catch (e) {}
  }

  try {
    const upstream = await fetch(IBGE_CEARA_API, {
      headers: { Accept: "application/json", "User-Agent": "Mpox-Ceara-Painel/2.0" }
    });
    if (!upstream.ok) throw new Error(`IBGE HTTP ${upstream.status}`);
    const municipalities = await upstream.json();
    municipalitiesCache = municipalities;
    municipalitiesCacheTime = now;
    sendJson(response, 200, municipalities);
  } catch (error) {
    municipalitiesCache = CEARA_MUNICIPALITY_FALLBACK;
    municipalitiesCacheTime = now;
    sendJson(response, 200, municipalitiesCache);
  }
}

async function proxyPopulacaoCeara(response) {
  const localFile = path.join(ROOT, "data", "populacao-ceara.json");
  if (fs.existsSync(localFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(localFile, "utf8"));
      sendJson(response, 200, data);
      return;
    } catch (e) {}
  }
  sendJson(response, 404, { error: "Dados de população não encontrados." });
}

async function proxyIntegraSUS(response) {
  try {
    const upstream = await fetch(INTEGRASUS_CSV, { cache: "no-store" });
    if (!upstream.ok) throw new Error(`IntegraSUS HTTP ${upstream.status}`);
    const text = await upstream.text();
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(text);
  } catch (e) {
    const local = path.join(ROOT, "data", "integrasus-mpox.json");
    if (fs.existsSync(local)) {
      sendJson(response, 200, JSON.parse(fs.readFileSync(local, "utf8")));
      return;
    }
    sendJson(response, 502, { error: "IntegraSUS dataset temporariamente indisponível." });
  }
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.resolve(ROOT, "." + decodeURIComponent(requestedPath));

  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not Found" : "Server Error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Accept, Content-Type"
    });
    response.end();
    return;
  }
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;

  // Rotas da API oficial do Monkeypox IntegraSUS
  if (pathname.startsWith("/api/monkeypox/")) {
    const subpath = pathname.replace("/api/monkeypox/", "");
    proxyIntegraDashboard(request, response, subpath);
  } else if (pathname === "/api/municipios-ceara") {
    proxyCearaMunicipalities(response);
  } else if (pathname === "/api/populacao-ceara") {
    proxyPopulacaoCeara(response);
  } else if (pathname === "/api/integrasus-mpox") {
    proxyIntegraSUS(response);
  } else {
    serveStatic(request, response);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Painel disponível em http://${HOST}:${PORT}`);
});
