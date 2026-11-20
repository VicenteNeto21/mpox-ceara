// Gera snapshots estáticos em /data para hospedagem sem backend (GitHub Pages).
// Uso: node scripts/build-data.js
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const INTEGRASUS_DASH_API = "https://integrasus.saude.ce.gov.br/api/monkeypox";
const INTEGRASUS_CSV = "https://datasets-integrasus.saude.ce.gov.br/datasets/download/33";
const UPSTREAM_API = "https://apidadosabertos.saude.gov.br/vigilancia-e-meio-ambiente/mpox";
const MPX_2026_ZIP = "https://s3.sa-east-1.amazonaws.com/ckan.saude.gov.br/mpox/csv/MPX_2026_OPENDATASUS.csv.zip";
const IBGE_MUNICIPIOS = "https://servicodados.ibge.gov.br/api/v1/localidades/estados/23/municipios";
const OUT = path.join(__dirname, "..", "data");

function parseCsv(text, delimiter = ";") {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const parse = (line) => {
    const out = []; let v = ""; let q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === delimiter && !q) { out.push(v.trim()); v = ""; }
      else v += c;
    }
    out.push(v.trim());
    return out;
  };
  const headers = parse(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parse(l);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
}

const isCE = (r) => String(r.co_uf_res || "").trim() === "23" || String(r.sg_uf || "").trim().toUpperCase() === "CE";

async function getJson(url, timeoutMs = 60000) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Painel Oficial IntegraSUS (https://integrasus.saude.ce.gov.br/#/indicadores/indicadores-vigilancia-saude/situacao-epidemiologica/monkeypox)
  try {
    const endpoints = [
      "cards",
      "casos-por-municipio",
      "casos-por-inicio-sintomas",
      "casos-por-sexo-faixa-etaria",
      "numero-casos-por-semana"
    ];
    const dashData = {
      ano: 2026,
      atualizadoEm: new Date().toISOString()
    };
    for (const ep of endpoints) {
      const url = `${INTEGRASUS_DASH_API}/${ep}?dataInicio=2026-01-01&dataFim=2026-12-31`;
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        dashData[ep] = await res.json();
      } catch (e) {
        console.warn(`Endpoint ${ep} falhou:`, e.message);
      }
    }
    fs.writeFileSync(path.join(OUT, "integrasus-dashboard.json"), JSON.stringify(dashData, null, 2));
    console.log("IntegraSUS Painel Oficial OK (Cards:", dashData.cards?.casosConfirmados, "confirmados /", dashData.cards?.casosNotificados, "notificações)");
  } catch (e) {
    console.warn("IntegraSUS Painel Oficial falhou:", e.message);
  }

  // 2. IntegraSUS Dataset Aberto
  try {
    const res = await fetch(INTEGRASUS_CSV, { signal: AbortSignal.timeout(60000) });
    if (res.ok) {
      const csvText = await res.text();
      const rows = parseCsv(csvText, ",");
      if (rows.length) {
        fs.writeFileSync(path.join(OUT, "integrasus-mpox.json"), JSON.stringify(rows));
        console.log("IntegraSUS Dataset OK:", rows.length, "registros");
      }
    }
  } catch (e) { console.warn("IntegraSUS Dataset falhou:", e.message); }

  // 3. Municípios IBGE
  let municipios = [];
  try {
    municipios = await getJson(IBGE_MUNICIPIOS);
    fs.writeFileSync(path.join(OUT, "municipios-ceara.json"), JSON.stringify(municipios));
    console.log("Municípios IBGE OK:", municipios.length);
  } catch (e) { console.warn("Municípios falhou:", e.message); }

  // 4. População IBGE
  try {
    if (municipios.length) {
      const ids = municipios.map(m => m.id).join("|");
      const popData = await getJson(`https://servicodados.ibge.gov.br/api/v1/pesquisas/indicadores/29171/resultados/${ids}`);
      const popMap = {};
      popData[0]?.res?.forEach(item => {
        const year = Object.keys(item.res).sort().reverse()[0];
        popMap[item.localidade] = Number(item.res[year]);
      });
      fs.writeFileSync(path.join(OUT, "populacao-ceara.json"), JSON.stringify(popMap));
      console.log("População Municípios OK:", Object.keys(popMap).length);
    }
  } catch (e) { console.warn("População IBGE falhou:", e.message); }

  // 5. Mpox 2026 OpenDataSUS
  try {
    const res = await fetch(MPX_2026_ZIP, { signal: AbortSignal.timeout(120000) });
    if (res.ok) {
      const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
      const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith(".csv"));
      if (entry) {
        const rows = parseCsv(entry.getData().toString("utf8"), ";").filter(isCE);
        fs.writeFileSync(path.join(OUT, "mpox-2026.json"), JSON.stringify(rows));
        console.log("Mpox 2026 OpenDataSUS OK:", rows.length);
      }
    }
  } catch (e) { console.warn("Mpox 2026 falhou:", e.message); }

  // 6. Metadados do Snapshot
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    version: "2.1.0"
  }, null, 2));
  console.log("Build finalizado com sucesso!");
}

main();
