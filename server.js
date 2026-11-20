const http = require("http");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const PORT = Number(process.env.PORT || 5500);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_API = "https://apidadosabertos.saude.gov.br/vigilancia-e-meio-ambiente/mpox";
const MPX_2026_ZIP = "https://s3.sa-east-1.amazonaws.com/ckan.saude.gov.br/mpox/csv/MPX_2026_OPENDATASUS.csv.zip";
const IBGE_CEARA_API = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/23/municipios";
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
  });
  response.end(JSON.stringify(value));
}

async function proxyMpox(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const limit = requestUrl.searchParams.get("limit") || "1000";
  const offset = requestUrl.searchParams.get("offset") || "0";
  const upstreamUrl = new URL(UPSTREAM_API);
  upstreamUrl.searchParams.set("limit", limit);
  upstreamUrl.searchParams.set("offset", offset);

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch (error) {
    console.error("Erro ao consultar API Mpox:", error);
    sendJson(response, 502, {
      error: "Não foi possível consultar a API do Ministério da Saúde.",
    });
  }
}

async function proxyCearaMunicipalities(response) {
  const now = Date.now();
  if (municipalitiesCache && now - municipalitiesCacheTime < 24 * 60 * 60 * 1000) {
    sendJson(response, 200, municipalitiesCache);
    return;
  }

  try {
    const upstream = await fetch(IBGE_CEARA_API, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mpox-Ceara-Painel/1.0",
      },
    });
    if (!upstream.ok) throw new Error(`IBGE respondeu com HTTP ${upstream.status}.`);
    const municipalities = await upstream.json();
    municipalitiesCache = municipalities;
    municipalitiesCacheTime = now;
    sendJson(response, 200, municipalities);
  } catch (error) {
    console.error("Erro ao consultar municipios do IBGE:", error);
    municipalitiesCache = CEARA_MUNICIPALITY_FALLBACK;
    municipalitiesCacheTime = now;
    sendJson(response, 200, municipalitiesCache);
  }
}

function parseSemicolonCsv(csvText) {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];

  const parseLine = (line) => {
    const values = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        quoted = !quoted;
      } else if (char === ";" && !quoted) {
        values.push(value.trim());
        value = "";
      } else {
        value += char;
      }
    }
    values.push(value.trim());
    return values;
  };

  const headers = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

async function proxyMpox2026(response) {
  const now = Date.now();
  if (mpox2026Cache && now - mpox2026CacheTime < 60 * 60 * 1000) {
    sendJson(response, 200, mpox2026Cache);
    return;
  }

  try {
    const upstream = await fetch(MPX_2026_ZIP);
    if (!upstream.ok) throw new Error(`Arquivo Mpox 2026 respondeu com HTTP ${upstream.status}.`);
    const zipBuffer = Buffer.from(await upstream.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const entry = zip.getEntries().find(item => item.entryName.toLowerCase().endsWith(".csv"));
    if (!entry) throw new Error("Arquivo CSV nao encontrado no pacote Mpox 2026.");

    const rows = parseSemicolonCsv(entry.getData().toString("utf8"));
    const cearaRows = rows.filter(row =>
      String(row.co_uf_res || "").trim() === "23" ||
      String(row.sg_uf || "").trim().toUpperCase() === "CE"
    );
    mpox2026Cache = cearaRows;
    mpox2026CacheTime = now;
    sendJson(response, 200, cearaRows);
  } catch (error) {
    console.error("Erro ao consultar arquivo Mpox 2026:", error);
    sendJson(response, 502, { error: "Nao foi possivel consultar os dados oficiais de Mpox 2026." });
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
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  if (pathname === "/api/mpox") {
    proxyMpox(request, response);
  } else if (pathname === "/api/mpox-2026") {
    proxyMpox2026(response);
  } else if (pathname === "/api/municipios-ceara") {
    proxyCearaMunicipalities(response);
  } else {
    serveStatic(request, response);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Painel disponível em http://localhost:${PORT}`);
});
