// Gera snapshots estáticos em /data para hospedagem sem backend (GitHub Pages).
// Uso: node scripts/build-data.js
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const INTEGRASUS_DASH_API = "https://integrasus.saude.ce.gov.br/api/monkeypox";
const INTEGRASUS_CSV = "https://datasets-integrasus.saude.ce.gov.br/datasets/download/33";
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

function normalizeName(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function titleCaseCity(str) {
  return String(str || "")
    .toLowerCase()
    .split(" ")
    .map(w => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(" ");
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.warn(`Aviso ao ler ${path.basename(filePath)}:`, e.message);
  }
  return null;
}

async function getJson(url, timeoutMs = 60000) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

function buildCityMap(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  list.forEach(item => {
    const raw = item.municipio || "";
    const norm = normalizeName(raw);
    if (!norm || norm === "SEM INFORMACAO") return;
    map.set(norm, {
      name: titleCaseCity(raw),
      code: item.codMunicipio || "",
      total: Number(item.total || 0)
    });
  });
  return map;
}

function formatSummaryText(deltas) {
  const parts = [];
  const fmt = (n, singular, plural) => `${n > 0 ? "+" : ""}${n} ${Math.abs(n) === 1 ? singular : plural}`;
  if (deltas.notificados !== 0) parts.push(fmt(deltas.notificados, "nova notificação", "novas notificações"));
  if (deltas.confirmados !== 0) parts.push(fmt(deltas.confirmados, "caso confirmado", "casos confirmados"));
  if (deltas.descartados !== 0) parts.push(fmt(deltas.descartados, "caso descartado", "casos descartados"));
  if (deltas.provaveis !== 0) parts.push(fmt(deltas.provaveis, "provável/suspeito", "prováveis/suspeitos"));
  if (!parts.length) return "Atualização na distribuição municipal dos registros";
  if (parts.length === 1) return `${parts[0]} na última atualização`;
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]} na última atualização`;
}

function buildMetaWithDelta(prevDash, prevMeta, currentDash) {
  const nowIso = new Date().toISOString();
  const newCards = currentDash?.cards || {};
  const currentTotals = {
    notificados: Number(newCards.casosNotificados || 0),
    confirmados: Number(newCards.casosConfirmados || 0),
    descartados: Number(newCards.casosDescartados || 0),
    provaveis: Number(newCards.casosProvaveis || 0) + Number(newCards.casosSuspeitos || 0)
  };

  let lastChange = prevMeta?.lastChange || null;
  let history = Array.isArray(prevMeta?.history) ? [...prevMeta.history] : [];

  if (prevDash?.cards && currentDash?.cards) {
    const prevCards = prevDash.cards;
    const prevTotals = {
      notificados: Number(prevCards.casosNotificados || 0),
      confirmados: Number(prevCards.casosConfirmados || 0),
      descartados: Number(prevCards.casosDescartados || 0),
      provaveis: Number(prevCards.casosProvaveis || 0) + Number(prevCards.casosSuspeitos || 0)
    };

    const deltas = {
      notificados: currentTotals.notificados - prevTotals.notificados,
      confirmados: currentTotals.confirmados - prevTotals.confirmados,
      descartados: currentTotals.descartados - prevTotals.descartados,
      provaveis: currentTotals.provaveis - prevTotals.provaveis
    };

    const prevCityMap = buildCityMap(prevDash["casos-por-municipio"]);
    const newCityMap = buildCityMap(currentDash["casos-por-municipio"]);
    const topCitiesDelta = [];

    newCityMap.forEach((curr, norm) => {
      const prevTotal = prevCityMap.get(norm)?.total || 0;
      const diff = curr.total - prevTotal;
      if (diff > 0) {
        topCitiesDelta.push({
          name: curr.name,
          code: curr.code,
          delta: diff,
          total: curr.total
        });
      }
    });

    topCitiesDelta.sort((a, b) => b.delta - a.delta || b.total - a.total);

    const hasChange = deltas.notificados !== 0 ||
      deltas.confirmados !== 0 ||
      deltas.descartados !== 0 ||
      deltas.provaveis !== 0 ||
      topCitiesDelta.length > 0;

    if (hasChange) {
      const prevDateStr = prevDash.atualizadoEm
        ? new Date(prevDash.atualizadoEm).toLocaleDateString("pt-BR")
        : "boletim anterior";
      const curDateStr = new Date(nowIso).toLocaleDateString("pt-BR");
      const periodLabel = prevDateStr === curDateStr
        ? `Atualização automática (${curDateStr})`
        : `Comparação ${prevDateStr} → ${curDateStr}`;

      lastChange = {
        detectedAt: nowIso,
        previousAt: prevDash.atualizadoEm || null,
        periodLabel,
        previousTotals: prevTotals,
        deltas,
        summaryText: formatSummaryText(deltas),
        topCitiesDelta: topCitiesDelta.slice(0, 8)
      };

      history = [lastChange, ...history].slice(0, 10);
      console.log("Delta detectado:", lastChange.summaryText);
    } else {
      console.log("Sem variação numérica desde o último boletim; histórico preservado.");
    }
  }

  return {
    generatedAt: nowIso,
    checkedAt: nowIso,
    version: "2.2.0",
    currentTotals,
    lastChange,
    history
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const prevDash = readJsonSafe(path.join(OUT, "integrasus-dashboard.json"));
  const prevMeta = readJsonSafe(path.join(OUT, "meta.json"));
  let currentDash = prevDash;

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
    let okCount = 0;
    for (const ep of endpoints) {
      const url = `${INTEGRASUS_DASH_API}/${ep}?dataInicio=2026-01-01&dataFim=2026-12-31`;
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        dashData[ep] = await res.json();
        okCount++;
      } catch (e) {
        console.warn(`Endpoint ${ep} falhou:`, e.message);
        if (prevDash?.[ep]) dashData[ep] = prevDash[ep];
      }
    }

    if (okCount > 0 && dashData.cards) {
      currentDash = dashData;
      fs.writeFileSync(path.join(OUT, "integrasus-dashboard.json"), JSON.stringify(dashData, null, 2));
      console.log("IntegraSUS Painel Oficial OK (Cards:", dashData.cards?.casosConfirmados, "confirmados /", dashData.cards?.casosNotificados, "notificações)");
    }
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

  // 6. Metadados do Snapshot + Delta Automático
  const metaOut = buildMetaWithDelta(prevDash, prevMeta, currentDash);
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(metaOut, null, 2));
  console.log("Build finalizado com sucesso!");
}

if (require.main === module) {
  main();
}

module.exports = { buildMetaWithDelta };
