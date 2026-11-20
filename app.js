const API_URL = "/api/mpox";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100; // limite de segurança; ajuste se a API documentar paginação maior.
let allCearaRows = [];
let municipalityNames = new Map();
const AUTO_REFRESH_MS = 60 * 1000;
const CEARA_MUNICIPALITY_FALLBACK = new Map([
  ["230440","Fortaleza"],["230370","Caucaia"],["231180","Russas"],["231290","Sobral"],
  ["230730","Juazeiro do Norte"],["230625","Itaitinga"],["230820","Meruoca"],
  ["231050","Pedra Branca"],["230765","Maracanaú"],["230100","Aquiraz"],
  ["230780","Marco"],["230523","Horizonte"],["230763","Madalena"],
  ["230770","Maranguape"],["231330","Tauá"],["231260","São Luís do Curu"],
  ["231080","Pereiro"],["231240","São Gonçalo do Amarante"]
]);
let timelineChart = null;
let statusChart = null;

const $ = (id) => document.getElementById(id);
const numberBR = (n) => Number(n || 0).toLocaleString("pt-BR");

function firstValue(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const found = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
    if (found && obj[found] !== null && obj[found] !== undefined && String(obj[found]).trim() !== "") return obj[found];
  }
  return "";
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  // A API pode encapsular os registros em uma chave cujo nome varia.
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function isCeara(row) {
  const uf = String(firstValue(row, ["sg_uf", "uf", "uf_res", "sg_uf_res", "co_uf_res", "estado", "uf_residencia", "sg_uf_residencia"])).trim().toUpperCase();
  if (uf === "CE" || uf === "CEARÁ" || uf === "CEARA") return true;
  if (String(row.co_uf_res || "").trim() === "23") return true;

  const code = String(firstValue(row, ["co_mun_res", "co_mun_not", "codigo_ibge", "co_municipio_ibge", "cod_municipio", "codigo_municipio"])).replace(/\D/g, "");
  if (code.startsWith("23") && code.length >= 6) return true;

  const city = normalize(firstValue(row, ["no_mun_res", "municipio_residencia", "municipio", "no_municipio", "nm_municipio", "cidade"]));
  return CEARA_CITIES.has(city);
}

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

// Lista de apoio para registros que tragam o nome do município, mas não a UF/código IBGE.
const CEARA_CITIES = new Set([
  "FORTALEZA","CAUCAIA","JUAZEIRO DO NORTE","MARACANAU","SOBRAL","CRATO","ITAPIPOCA","MARANGUAPE",
  "IGUATU","QUIXADA","CANINDE","PACATUBA","AQUIRAZ","QUIXERAMOBIM","RUSSAS","ARACATI","CRATEUS",
  "TIANGUA","CAMOCIM","ACARAU","BREJO SANTO","LIMOEIRO DO NORTE","TAUA","BARBALHA","HORIZONTE",
  "SAO GONCALO DO AMARANTE","EUSEBIO","CASCAVEL","ICAPUI","MORADA NOVA","BATURITE","BOA VIAGEM",
  "ITAPAGE","GUARACIABA DO NORTE","VARZEA ALEGRE","MAURITI","GRANJA","MASSAPE","NOVA RUSSAS",
  "PEDRA BRANCA","SANTA QUITERIA","CANINDE","IPU","JAGUARIBE","ACOPIARA","CAMPOS SALES"
]);

function getCity(row) {
  const code = String(firstValue(row, ["id_municip", "id_mn_resi", "co_mun_res", "co_mun_not", "codigo_ibge", "co_municipio_ibge", "cod_municipio", "codigo_municipio"]) || "").replace(/\D/g, "");
  if (municipalityNames.has(code)) return municipalityNames.get(code);
  if (CEARA_MUNICIPALITY_FALLBACK.has(code)) return CEARA_MUNICIPALITY_FALLBACK.get(code);
  if (code.length === 7) {
    const municipalityCode6 = code.slice(0, 6);
    if (municipalityNames.has(municipalityCode6)) return municipalityNames.get(municipalityCode6);
    if (CEARA_MUNICIPALITY_FALLBACK.has(municipalityCode6)) return CEARA_MUNICIPALITY_FALLBACK.get(municipalityCode6);
  }
  const name = String(firstValue(row, ["no_mun_res", "municipio_residencia", "municipio", "no_municipio", "nm_municipio", "cidade", "no_mun_not"]) || "").trim();
  return name || "Município não identificado";
}
function getDate(row) {
  return firstValue(row, ["dt_notific", "dt_sin_pri", "dt_interna", "data_notificacao", "data", "dt_diagnostico", "data_inicio_sintomas"]);
}
function getStatus(row) {
  return normalize(firstValue(row, ["classificacao_final", "classificacao", "resultado", "status", "classi_fin", "ds_classificacao_final", "tp_classificacao"]));
}
function getEvolution(row) {
  return normalize(firstValue(row, ["evolucao", "evolucao_caso", "tp_evolucao", "ds_evolucao"]));
}
function dateParts(value) {
  if (!value) return null;
  const str = String(value);
  let d;
  const brazilian = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brazilian) d = new Date(`${brazilian[3]}-${brazilian[2]}-${brazilian[1]}T12:00:00`);
  else if (/^\d{4}-\d{2}-\d{2}/.test(str)) d = new Date(str.slice(0,10) + "T12:00:00");
  else if (/^\d{8}$/.test(str)) d = new Date(`${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}T12:00:00`);
  else d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function showAlert(message, type = "warning") {
  $("alertArea").innerHTML = `<div class="alert alert-${type} mb-0"><i class="bi bi-info-circle me-2"></i>${message}</div>`;
}
function clearAlert() { $("alertArea").innerHTML = ""; }

async function fetchAllPages() {
  const collected = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${API_URL}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    if (response.status === 404) break;
    if (!response.ok) throw new Error(`A API respondeu com HTTP ${response.status}.`);
    const payload = await response.json();
    const rows = extractRows(payload);
    if (!rows.length) break;
    collected.push(...rows);
    $("dataStatus").innerHTML = `<i class="bi bi-arrow-repeat"></i> Consultando base oficial · ${numberBR(collected.length)} registros`;
    if (rows.length < PAGE_SIZE) break;
  }
  return collected;
}

async function loadData() {
  const btn = $("refreshBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Consultando';
  $("dataStatus").classList.remove("ok");
  $("dataStatus").innerHTML = '<i class="bi bi-circle-fill"></i> Consultando a API do Ministério da Saúde...';
  clearAlert();
  try {
    const [nationalRows, municipalitiesResponse, mpox2026Response] = await Promise.all([
      fetchAllPages(),
      fetch("/api/municipios-ceara", { headers: { "Accept": "application/json" } }),
      fetch("/api/mpox-2026", { headers: { "Accept": "application/json" } }),
    ]);
    let municipalities = [];
    if (municipalitiesResponse.ok) {
      municipalities = await municipalitiesResponse.json();
    } else {
      try {
        const ibgeResponse = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/estados/23/municipios", {
          headers: { "Accept": "application/json" },
        });
        if (ibgeResponse.ok) municipalities = await ibgeResponse.json();
      } catch (error) {
        console.warn("Consulta dos municipios do IBGE indisponivel:", error);
      }
    }
    municipalityNames = new Map();
    municipalities.forEach(item => {
      const code = String(item.id);
      municipalityNames.set(code, item.nome);
      if (code.length === 7) municipalityNames.set(code.slice(0, 6), item.nome);
    });
    let mpox2026Rows = [];
    if (mpox2026Response.ok) {
      mpox2026Rows = await mpox2026Response.json();
    } else {
      console.warn("Arquivo oficial Mpox 2026 indisponivel.");
    }
    allCearaRows = [...nationalRows.filter(isCeara), ...mpox2026Rows];
    if (!nationalRows.length) throw new Error("A API respondeu, mas não retornou registros. Verifique a disponibilidade do serviço.");
    if (!allCearaRows.length) {
      showAlert("A consulta retornou dados, mas não foi possível identificar registros do Ceará com os campos reconhecidos. É necessário conferir o formato atual da resposta da API antes de apresentar indicadores estaduais.", "warning");
    } else if (nationalRows.length >= PAGE_SIZE * MAX_PAGES) {
      showAlert("A consulta atingiu o limite de segurança de páginas configurado no código. Confira se todos os registros do Ceará foram carregados.", "warning");
    }
    $("lastUpdated").textContent = new Date().toLocaleString("pt-BR");
    $("dataStatus").classList.add("ok");
    const rows2026 = allCearaRows.filter(row => String(getDate(row)).startsWith("2026")).length;
    $("dataStatus").innerHTML = `<i class="bi bi-circle-fill"></i> Conectado · ${numberBR(nationalRows.length)} registros consultados`;
    if (mpox2026Rows.length) {
      showAlert(`Dados oficiais de 2026 carregados: ${numberBR(mpox2026Rows.length)} notificações no Ceará pelo arquivo nacional OpenDataSUS, atualizado em 10/09/2026. Os números podem diferir do boletim estadual agregado.`, "success");
    } else if (rows2026 === 0) {
      showAlert("A atualização automática está ativa, mas os dados oficiais de 2026 não puderam ser carregados neste momento.", "warning");
    }
    populateYears();
    renderDashboard();
  } catch (error) {
    console.error("Erro ao consultar API Mpox:", error);
    showAlert(`Não foi possível carregar os dados automaticamente. ${error.message} Se estiver abrindo o arquivo diretamente, execute o projeto em um servidor local (ex.: Live Server) e verifique a disponibilidade/CORS da API.`, "danger");
    $("dataStatus").innerHTML = '<i class="bi bi-exclamation-circle"></i> Falha na consulta';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise me-2"></i>Atualizar dados';
  }
}

function populateYears() {
  const years = [...new Set(allCearaRows.map(r => dateParts(getDate(r))).filter(Boolean).map(d => d.getFullYear()))].sort((a,b) => b-a);
  const select = $("yearFilter");
  const current = select.value;
  select.innerHTML = '<option value="all">Todos os anos</option>' + years.map(y => `<option value="${y}">${y}</option>`).join("");
  if (years.includes(Number(current))) select.value = current;
}

function filteredRows() {
  const year = $("yearFilter").value;
  const cityQuery = normalize($("citySearch").value);
  return allCearaRows.filter(row => {
    const d = dateParts(getDate(row));
    const city = normalize(getCity(row));
    return (year === "all" || (d && d.getFullYear() === Number(year))) && (!cityQuery || city.includes(cityQuery));
  });
}

function renderDashboard() {
  const rows = filteredRows();
  const classified = rows.map(getStatus).filter(Boolean);
  const confirmed = classified.filter(s => s.includes("CONFIRM")).length;
  const suspected = classified.filter(s => s.includes("SUSPEIT") || s.includes("INVESTIG")).length;
  const deaths = rows.filter(r => {
    const e = getEvolution(r);
    return e.includes("OBITO") || e.includes("ÓBITO") || e === "4";
  }).length;

  $("totalKpi").textContent = numberBR(rows.length);
  $("confirmedKpi").textContent = classified.length ? numberBR(confirmed) : "N/D";
  $("suspectedKpi").textContent = classified.length ? numberBR(suspected) : "N/D";
  $("deathsKpi").textContent = rows.some(r => getEvolution(r)) ? numberBR(deaths) : "N/D";

  renderTimeline(rows);
  renderStatus(rows);
  renderCities(rows);
}

function renderTimeline(rows) {
  const counts = new Map();
  rows.forEach(row => {
    const d = dateParts(getDate(row));
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const labels = [...counts.keys()].sort();
  const values = labels.map(k => counts.get(k));
  $("timelineEmpty").style.display = labels.length ? "none" : "grid";
  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart($("timelineChart"), {
    type: "line",
    data: { labels: labels.map(k => { const [y,m]=k.split("-"); return new Date(Number(y),Number(m)-1,1).toLocaleDateString("pt-BR",{month:"short",year:"2-digit"}); }),
      datasets: [{ data: values, borderColor:"#159b83", backgroundColor:"rgba(21,155,131,.10)", fill:true, tension:.35, borderWidth:2.5, pointRadius:3, pointBackgroundColor:"#159b83" }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},tooltip:{displayColors:false}}, scales:{x:{grid:{display:false},ticks:{color:"#8996a2",font:{size:10}}},y:{beginAtZero:true,grid:{color:"#edf1f4"},ticks:{precision:0,color:"#8996a2",font:{size:10}}}}}
  });
}

function renderStatus(rows) {
  const groups = new Map();
  rows.forEach(r => { const s = getStatus(r); if (s) groups.set(s, (groups.get(s)||0)+1); });
  const entries = [...groups.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
  $("statusEmpty").style.display = entries.length ? "none" : "grid";
  $("statusLegend").innerHTML = entries.map(([name,count],i)=>`<span><i class="legend-dot" style="background:${["#159b83","#e0a13c","#517da5","#8c78b8","#d47777","#94a3ad"][i]}"></i>${escapeHtml(titleCase(name))} · ${numberBR(count)}</span>`).join("");
  if (statusChart) statusChart.destroy();
  statusChart = new Chart($("statusChart"), {type:"doughnut",data:{labels:entries.map(e=>e[0]),datasets:[{data:entries.map(e=>e[1]),backgroundColor:["#159b83","#e0a13c","#517da5","#8c78b8","#d47777","#94a3ad"],borderWidth:0,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:"72%",plugins:{legend:{display:false}}}});
}

function renderCities(rows) {
  const counts = new Map();
  rows.forEach(r => { const city=getCity(r); counts.set(city,(counts.get(city)||0)+1); });
  const entries = [...counts.entries()].sort((a,b)=>b[1]-a[1]);
  const max = entries[0]?.[1] || 1;
  const totalMunicipal = entries.reduce((sum, [, count]) => sum + count, 0);
  $("cityBars").innerHTML = entries.length
    ? entries.slice(0,8).map(([city,count], index) => {
        const share = totalMunicipal ? (count / totalMunicipal) * 100 : 0;
        return `<div class="city-row"><span class="city-rank">${String(index + 1).padStart(2,"0")}</span><div class="city-main"><span class="city-name" title="${escapeHtml(city)}">${escapeHtml(city)}</span><div class="bar-track"><div class="bar-fill" style="width:${(count/max)*100}%"></div></div></div><div class="city-result"><strong>${numberBR(count)}</strong><small>${share.toLocaleString("pt-BR",{maximumFractionDigits:1})}%</small></div></div>`;
      }).join("")
    : '<div class="empty-state">Nenhum registro municipal identificado.</div>';
  $("tableCount").textContent = `${entries.length} ${entries.length === 1 ? "município" : "municípios"}`;
  $("cityTable").innerHTML = entries.length
    ? entries.map(([city,count], index) => {
        const share = rows.length ? (count / rows.length) * 100 : 0;
        return `<tr><td><span class="table-rank">${String(index + 1).padStart(2,"0")}</span><strong>${escapeHtml(city)}</strong></td><td class="text-end">${numberBR(count)}</td><td class="text-end">${share.toLocaleString("pt-BR",{maximumFractionDigits:1})}%</td></tr>`;
      }).join("")
    : '<tr><td colspan="3" class="text-center py-4 text-secondary">Nenhum dado municipal identificado.</td></tr>';
}

function titleCase(value) { return String(value).toLowerCase().replace(/\b\w/g, c=>c.toUpperCase()); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

$("refreshBtn").addEventListener("click", loadData);
$("yearFilter").addEventListener("change", renderDashboard);
$("citySearch").addEventListener("input", renderDashboard);
$("clearFilters").addEventListener("click", () => { $("yearFilter").value="all"; $("citySearch").value=""; renderDashboard(); });
loadData();
setInterval(loadData, AUTO_REFRESH_MS);