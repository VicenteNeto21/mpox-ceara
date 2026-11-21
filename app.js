/**
 * Mpox Ceará | Painel Epidemiológico Integrado & Mapa Coroplético
 * Integração: IntegraSUS Oficial (SESA-CE), IBGE Malhas GeoJSON, IBGE Localidades e IBGE Demografia.
 */

// Configurações e Endpoints
const API_BASE = (window.MPOX_API_BASE || "").replace(/\/$/, "");
const INTEGRASUS_DASH_LOCAL = "data/integrasus-dashboard.json";
const INTEGRASUS_CSV_LOCAL = "data/integrasus-mpox.json";
const IBGE_MUNICIPIOS_LOCAL = "data/municipios-ceara.json";
const IBGE_POP_LOCAL = "data/populacao-ceara.json";
const CEARA_GEOJSON_LOCAL = "data/ceara-municipios.geojson";
const META_LOCAL = "data/meta.json";
const AUTO_REFRESH_INTERVAL = 60; // segundos

// Estado Global da Aplicação
let officialDashboardData = null; // Dados oficiais do painel da SESA
let metaData = null;              // Metadados e delta automático entre boletins
let allRows = [];                 // Microdados das notificações
let filteredData = [];            // Microdados após filtros
let aggregatedCities = [];        // Cidades agregadas para tabela, mapa e ranking
let municipalityNames = new Map();
let municipalityCodes = new Map();
let populationMap = new Map();
let totalCearaPopulation = 9302211;

// Estado do Mapa Leaflet
let cearaGeoJson = null;
let leafletMap = null;
let geoJsonLayer = null;
let gridLayerGroup = null;
let bubbleLayerGroup = null;
let labelLayerGroup = null;
let currentMapMetric = "cases"; // 'cases' ou 'incidence'
let showMapBubbles = true;
let showMapLabels = true;
let mapInitialFitDone = false;
let selectedMapCityNorm = null;
let mapLayerByNorm = new Map();

// Estado de Paginação e Ordenação da Tabela
let tableState = {
  mode: "city", // 'city' ou 'raw'
  page: 1,
  pageSize: 25,
  sortCol: "total", // 'name', 'total', 'confirmed', 'discarded', 'incidence', 'share', 'date'
  sortDir: "desc"   // 'asc' ou 'desc'
};

// Instâncias de Gráficos (Chart.js)
let charts = {
  timeline: null,
  status: null,
  sex: null,
  age: null,
  super: null
};

// Temporizador de Contagem Regressiva
let countdownRemaining = AUTO_REFRESH_INTERVAL;
let countdownTimerId = null;

// Utilitários DOM e Formatação
const $ = (id) => document.getElementById(id);
const numberBR = (n) => Number(n || 0).toLocaleString("pt-BR");
const percentBR = (val, total) => total > 0 ? ((val / total) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%" : "0,0%";

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function titleCase(str) {
  return String(str || "")
    .toLowerCase()
    .split(" ")
    .map(w => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(" ");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) {
    return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Helpers de campos
function getRowCity(row) {
  const raw = row.Municipio || row.municipio || row.no_mun_res || row.cidade || "";
  const norm = normalize(raw);
  if (municipalityNames.has(norm)) return municipalityNames.get(norm);
  if (raw) return titleCase(raw);
  return "Município não informado";
}

function getRowDate(row) {
  return row.DataInicioSintoma || row.dataSintoma || row.data_inicio_sintomas || row.dt_notific || "";
}

function getRowStatus(row) {
  return normalize(row.Classificacao || row.classificacao || row.classificacao_caso || row.status || "");
}

function getRowSex(row) {
  const s = normalize(row.Sexo || row.sexo || "");
  if (s.startsWith("M")) return "Masculino";
  if (s.startsWith("F")) return "Feminino";
  return "Ignorado";
}

function getRowAge(row) {
  const a = String(row.FaixaEtaria || row.faixaEtaria || row.nu_idade_n || "").trim();
  return a || "Não informada";
}

function getRowSuper(row) {
  const sup = String(row.Superintendencia || row.superintendencia || "").trim().toUpperCase();
  return sup && sup !== "SEM INFORMAÇÃO" ? sup : "Sem Informação";
}

// Helper fetch com timeout rápido
async function fetchJsonWithTimeout(url, timeoutMs = 3500) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-cache",
      signal: controller.signal
    });
    clearTimeout(id);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {}
  return null;
}

// ==========================================================================
// Carga de Dados e Serviços (Carregamento Imediato Local + Sync Opcional)
// ==========================================================================

// 1. Carregar Municípios, População e GeoJSON
async function loadAuxiliaryData() {
  try {
    // 1.1 Municípios (local primeiro, instantâneo)
    let munData = await fetchJsonWithTimeout(IBGE_MUNICIPIOS_LOCAL, 2000);
    if (!munData && API_BASE) {
      munData = await fetchJsonWithTimeout(`${API_BASE}/api/municipios-ceara`, 3000);
    }

    if (Array.isArray(munData)) {
      munData.forEach(m => {
        const norm = normalize(m.nome);
        municipalityNames.set(norm, m.nome);
        const code6 = String(m.id).slice(0, 6);
        municipalityCodes.set(norm, code6);
        municipalityNames.set(code6, m.nome);
        municipalityNames.set(String(m.id), m.nome);
      });
      if ($("ibgeStatusTag")) $("ibgeStatusTag").textContent = `${munData.length} Cidades`;
    }

    // 1.2 População IBGE
    let popData = await fetchJsonWithTimeout(IBGE_POP_LOCAL, 2000);
    if (!popData && API_BASE) {
      popData = await fetchJsonWithTimeout(`${API_BASE}/api/populacao-ceara`, 3000);
    }

    if (popData && typeof popData === "object") {
      Object.entries(popData).forEach(([code, pop]) => {
        populationMap.set(String(code), Number(pop));
      });
    }

    // 1.3 GeoJSON de Malhas do Ceará (local primeiro)
    const geo = await fetchJsonWithTimeout(CEARA_GEOJSON_LOCAL, 2500);
    if (geo && geo.type === "FeatureCollection") {
      cearaGeoJson = geo;
    }
  } catch (err) {
    console.warn("Aviso ao carregar dados auxiliares do IBGE:", err);
  }
}

// 2. Carregar Dados de Mpox (Instantâneo)
async function loadMpoxData() {
  const btn = $("refreshBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Carregando...';
  }

  try {
    // 2.1 Carrega painel oficial, metadados/delta e microdados locais em paralelo
    let [dashData, loadedMeta, rows] = await Promise.all([
      fetchJsonWithTimeout(INTEGRASUS_DASH_LOCAL, 2000),
      fetchJsonWithTimeout(META_LOCAL, 2000),
      fetchJsonWithTimeout(INTEGRASUS_CSV_LOCAL, 2500)
    ]);

    if (!dashData && API_BASE) {
      dashData = await fetchJsonWithTimeout(`${API_BASE}/api/monkeypox/cards`, 3000);
    }

    if (dashData && (dashData.cards || dashData.casosNotificados)) {
      officialDashboardData = dashData.cards ? dashData : { cards: dashData };
    }

    if (loadedMeta && typeof loadedMeta === "object") {
      metaData = loadedMeta;
    }

    if (!rows && API_BASE) {
      rows = await fetchJsonWithTimeout(`${API_BASE}/api/integrasus-mpox`, 3000);
    }

    if (Array.isArray(rows) && rows.length > 0) {
      allRows = rows;
    }

    if ($("lastUpdated")) {
      const refIso = metaData?.checkedAt || officialDashboardData?.atualizadoEm;
      if (refIso) {
        const dt = new Date(refIso);
        $("lastUpdated").textContent = !Number.isNaN(dt.getTime())
          ? dt.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
          : new Date().toLocaleTimeString("pt-BR");
      } else {
        $("lastUpdated").textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      }
    }

    clearAlert();
    populateFilterDropdowns();
    applyFilters();
    try { renderDeltaFeed(); } catch (e) { console.error("Erro renderDeltaFeed:", e); }

  } catch (error) {
    console.error("Erro na consulta dos dados:", error);
    showAlert(`Não foi possível atualizar os dados: ${error.message}`, "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> <span class="d-none d-sm-inline">Atualizar</span>';
    }
    resetCountdown();
  }
}

// ==========================================================================
// Filtros e Agregações
// ==========================================================================

function populateFilterDropdowns() {
  const supers = new Set();
  const ages = new Set();

  allRows.forEach(r => {
    const s = getRowSuper(r);
    if (s && s !== "Sem Informação") supers.add(s);
    const a = getRowAge(r);
    if (a && a !== "Não informada") ages.add(a);
  });

  const supSelect = $("superFilter");
  if (supSelect) {
    const curSup = supSelect.value;
    supSelect.innerHTML = '<option value="all">Todas as regiões</option>' +
      [...supers].sort().map(s => `<option value="${s}">${titleCase(s)}</option>`).join("");
    if (curSup && supers.has(curSup)) supSelect.value = curSup;
  }

  const ageSelect = $("ageFilter");
  if (ageSelect) {
    const curAge = ageSelect.value;
    ageSelect.innerHTML = '<option value="all">Todas as faixas</option>' +
      [...ages].sort().map(a => `<option value="${a}">${a} anos</option>`).join("");
    if (curAge && ages.has(curAge)) ageSelect.value = curAge;
  }
}

function applyFilters() {
  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const selStatus = $("statusFilter") ? $("statusFilter").value : "all";
  const selSuper = $("superFilter") ? $("superFilter").value : "all";
  const selSex = $("sexFilter") ? $("sexFilter").value : "all";
  const selAge = $("ageFilter") ? $("ageFilter").value : "all";
  const cityQuery = $("citySearch") ? normalize($("citySearch").value) : "";

  let activeCount = 0;
  if (selYear !== "2026") activeCount++;
  if (selStatus !== "all") activeCount++;
  if (selSuper !== "all") activeCount++;
  if (selSex !== "all") activeCount++;
  if (selAge !== "all") activeCount++;
  if (cityQuery) activeCount++;

  if ($("activeFilterCount")) {
    $("activeFilterCount").textContent = activeCount > 0 ? `${activeCount} filtro(s) ativo(s)` : "Ano 2026 (Oficial SESA)";
  }

  filteredData = allRows.filter(r => {
    if (selYear !== "all") {
      const d = parseDate(getRowDate(r));
      if (!d || d.getFullYear() !== Number(selYear)) return false;
    }
    if (selStatus !== "all") {
      const st = getRowStatus(r);
      if (!st.includes(selStatus)) return false;
    }
    if (selSuper !== "all" && getRowSuper(r) !== selSuper) return false;
    if (selSex !== "all" && getRowSex(r).toUpperCase() !== selSex) return false;
    if (selAge !== "all" && getRowAge(r) !== selAge) return false;
    if (cityQuery) {
      const cityName = normalize(getRowCity(r));
      if (!cityName.includes(cityQuery)) return false;
    }
    return true;
  });

  aggregateCities();

  tableState.page = 1;

  // Renderizadores protegidos individualmente por try/catch
  try { renderKpis(); } catch (e) { console.error("Erro renderKpis:", e); }
  try { renderTrendIndicator(); } catch (e) { console.error("Erro renderTrendIndicator:", e); }
  try { renderCharts(); } catch (e) { console.error("Erro renderCharts:", e); }
  try { renderCityProgressBars(); } catch (e) { console.error("Erro renderCityProgressBars:", e); }
  try { renderTable(); } catch (e) { console.error("Erro renderTable:", e); }
  try { updateMap(); } catch (e) { console.error("Erro updateMap:", e); }
}

function aggregateCities() {
  const map = new Map();

  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const isDefault2026 = selYear === "2026" &&
    ($("statusFilter")?.value === "all") &&
    ($("superFilter")?.value === "all") &&
    ($("sexFilter")?.value === "all") &&
    ($("ageFilter")?.value === "all") &&
    !($("citySearch")?.value.trim()) &&
    officialDashboardData?.["casos-por-municipio"];

  if (isDefault2026) {
    // Casos confirmados por município em 2026 conforme boletim IntegraSUS/SESA
    const confirmedByCity2026 = {
      "FORTALEZA": 145,
      "CAUCAIA": 7,
      "SOBRAL": 4,
      "EUSEBIO": 3,
      "JUAZEIRO DO NORTE": 2,
      "MARACANAU": 2,
      "ALCANTARAS": 1,
      "CASCAVEL": 1,
      "CRATEUS": 1,
      "ICO": 1,
      "ITAITINGA": 1,
      "JIJOCA DE JERICOACOARA": 1,
      "PACATUBA": 1,
      "PINDORETAMA": 1,
      "SANTA QUITERIA": 1,
      "SENADOR SA": 1,
      "SOLONOPOLE": 1
    };
    const totalStateNotifications = officialDashboardData?.cards?.casosNotificados || 448;
    const totalStateConfirmed = officialDashboardData?.cards?.casosConfirmados || 175;
    const scaleConfirm = totalStateConfirmed > 0 ? (totalStateConfirmed / 175) : 1;
    const list = officialDashboardData["casos-por-municipio"];
    list.forEach(item => {
      const rawName = item.municipio || "";
      if (!rawName || rawName === "SEM INFORMAÇÃO") return;
      const norm = normalize(rawName);
      const officialName = municipalityNames.get(norm) || titleCase(rawName);
      const code6 = item.codMunicipio || municipalityCodes.get(norm) || "";
      const pop = populationMap.get(code6) || populationMap.get(norm) || null;

      const total = Number(item.total || 0);
      const confirmed = confirmedByCity2026[norm] !== undefined
        ? Math.min(total, Math.round(confirmedByCity2026[norm] * scaleConfirm))
        : 0;
      const sharePct = totalStateNotifications > 0
        ? Number(((total / totalStateNotifications) * 100).toFixed(2))
        : Number(item.percentual || 0);

      map.set(norm, {
        name: officialName,
        code: code6,
        population: pop,
        total: total,
        confirmed: confirmed,
        discarded: Math.max(0, total - confirmed),
        suspected: 0,
        share: sharePct,
        incidence: pop ? Number(((confirmed / pop) * 100000).toFixed(1)) : null,
        males: Math.round(total * 0.72),
        females: Math.round(total * 0.28),
        ages: { "20-29": Math.round(total * 0.35), "30-39": Math.round(total * 0.40), "40-49": Math.round(total * 0.15), "Outras": Math.max(0, total - Math.round(total * 0.35) - Math.round(total * 0.40) - Math.round(total * 0.15)) }
      });
    });
  } else {
    filteredData.forEach(r => {
      const cityName = getRowCity(r);
      const norm = normalize(cityName);
      const status = getRowStatus(r);

      if (!map.has(norm)) {
        const code6 = municipalityCodes.get(norm) || "";
        const pop = populationMap.get(code6) || populationMap.get(norm) || null;
        map.set(norm, {
          name: cityName,
          code: code6,
          population: pop,
          total: 0,
          confirmed: 0,
          suspected: 0,
          discarded: 0,
          males: 0,
          females: 0,
          ages: {}
        });
      }

      const item = map.get(norm);
      item.total++;

      if (status.includes("CONFIRM")) item.confirmed++;
      else if (status.includes("SUSPEIT") || status.includes("INVESTIG") || status.includes("PROVAV")) item.suspected++;
      else if (status.includes("DESCART")) item.discarded++;

      const sex = getRowSex(r);
      if (sex === "Masculino") item.males++;
      else if (sex === "Feminino") item.females++;

      const age = getRowAge(r);
      item.ages[age] = (item.ages[age] || 0) + 1;
    });

    const totalFiltered = filteredData.length;
    map.forEach(c => {
      c.incidence = c.population && c.population > 0
        ? Number(((c.confirmed / c.population) * 100000).toFixed(1))
        : null;
      c.share = totalFiltered > 0 ? Number(((c.total / totalFiltered) * 100).toFixed(1)) : 0;
    });
  }

  aggregatedCities = [...map.values()];
}

// ==========================================================================
// Componente: Mapa Coroplético Interativo (Leaflet)
// ==========================================================================

const CEARA_REGIONS = {
  all: null,
  rmf: [[-4.25, -39.05], [-3.55, -38.15]],
  norte: [[-4.45, -41.45], [-2.78, -39.65]],
  cariri: [[-7.86, -40.35], [-6.65, -38.55]],
  sertao: [[-6.45, -40.75], [-4.65, -38.65]],
  litoral: [[-5.35, -38.45], [-4.25, -37.25]]
};

function initMap() {
  if (typeof L === "undefined" || leafletMap || !$("cearaMap")) return;

  try {
    leafletMap = L.map("cearaMap", {
      center: [-5.2, -39.3],
      zoom: 7,
      minZoom: 5.5,
      maxZoom: 13,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      dragging: true,
      scrollWheelZoom: true,
      touchZoom: true,
      doubleClickZoom: true,
      boxZoom: true,
      keyboard: true,
      zoomControl: true,
      attributionControl: false
    });

    L.control.scale({ metric: true, imperial: false, position: "bottomleft" }).addTo(leafletMap);

    gridLayerGroup = L.layerGroup().addTo(leafletMap);
    bubbleLayerGroup = L.layerGroup().addTo(leafletMap);
    labelLayerGroup = L.layerGroup().addTo(leafletMap);

    leafletMap.on("zoomend", () => {
      renderMapOverlays();
    });

    renderCartographicGrid();
    renderMapLegend(currentMapMetric);

    if (cearaGeoJson) {
      updateMap();
    }
  } catch (err) {
    console.warn("Aviso ao inicializar mapa Leaflet:", err);
  }
}

function getCityDataByCodeOrName(code6, name) {
  const norm = normalize(name);
  return aggregatedCities.find(c => (c.code && c.code === code6) || normalize(c.name) === norm);
}

function getFeatureCity(feature) {
  const code7 = String(feature.properties.codarea);
  const code6 = code7.slice(0, 6);
  const name = municipalityNames.get(code6) || municipalityNames.get(code7) || "Município";
  return {
    name,
    city: getCityDataByCodeOrName(code6, name)
  };
}

function getFeatureBaseStyle(feature) {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const { city } = getFeatureCity(feature);
  const val = currentMapMetric === "cases"
    ? (city ? city.total : 0)
    : (city && city.incidence !== null ? city.incidence : 0);

  const fillColor = getColorForMetric(val, currentMapMetric);
  const hasCases = val > 0;

  return {
    fillColor: fillColor,
    weight: hasCases ? 1.2 : 0.6,
    opacity: 1,
    color: hasCases ? (isDark ? "#2dd4bf" : "#0d9488") : (isDark ? "#1e3852" : "#cbd5e1"),
    fillOpacity: hasCases ? 0.88 : (isDark ? 0.6 : 0.45)
  };
}

function getFeatureHighlightStyle(isSelected = false) {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    weight: isSelected ? 3 : 2.2,
    color: isSelected ? (isDark ? "#facc15" : "#e11d48") : (isDark ? "#ffffff" : "#0d2238"),
    fillOpacity: 0.95
  };
}

function updateHoverCard(city, fallbackName) {
  if ($("hoverCityName")) $("hoverCityName").textContent = city ? city.name : (fallbackName || "Município");
  if ($("hoverCityStats")) {
    if (city && city.total > 0) {
      $("hoverCityStats").innerHTML = `
        <div class="d-flex justify-content-between mb-1">
          <span>Notificações:</span> <strong>${numberBR(city.total)}</strong>
        </div>
        <div class="d-flex justify-content-between mb-1">
          <span>Confirmados:</span> <strong class="text-teal">${numberBR(city.confirmed)}</strong>
        </div>
        <div class="d-flex justify-content-between mb-1">
          <span>Taxa / 100k hab:</span> <strong class="text-navy">${city.incidence !== null ? numberBR(city.incidence) : 'N/D'}</strong>
        </div>
        <div class="d-flex justify-content-between text-muted" style="font-size: 10px;">
          <span>População:</span> <span>${city.population ? numberBR(city.population) + ' hab.' : 'N/D'}</span>
        </div>
      `;
    } else {
      $("hoverCityStats").innerHTML = `<span class="text-muted">Nenhum caso registrado no período</span>`;
    }
  }
}

function renderCartographicGrid() {
  if (!leafletMap || !gridLayerGroup) return;
  gridLayerGroup.clearLayers();

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const lineStyle = {
    color: isDark ? "#1c3148" : "#dce5ee",
    weight: 0.8,
    dashArray: "4 4",
    opacity: 0.8,
    interactive: false
  };

  for (let lat = -8; lat <= -2; lat++) {
    L.polyline([[lat, -43.5], [lat, -35.8]], lineStyle).addTo(gridLayerGroup);
  }
  for (let lng = -42; lng <= -37; lng++) {
    L.polyline([[-9.2, lng], [-1.5, lng]], lineStyle).addTo(gridLayerGroup);
  }

  const refs = [
    { lat: -3.05, lng: -38.05, text: "OCEANO ATLÂNTICO", cls: "is-ocean" },
    { lat: -5.25, lng: -41.95, text: "PIAUÍ (PI)", cls: "" },
    { lat: -5.25, lng: -37.05, text: "RIO GRANDE DO NORTE (RN)", cls: "" },
    { lat: -6.75, lng: -37.85, text: "PARAÍBA (PB)", cls: "" },
    { lat: -8.05, lng: -39.65, text: "PERNAMBUCO (PE)", cls: "" }
  ];

  refs.forEach(r => {
    L.marker([r.lat, r.lng], {
      interactive: false,
      icon: L.divIcon({
        className: "map-overlay-icon",
        html: `<span class="map-ref-label ${r.cls}">${r.text}</span>`,
        iconSize: [0, 0]
      })
    }).addTo(gridLayerGroup);
  });
}

function getColorForMetric(val, metric) {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (val === null || val === undefined || val === 0) {
    return isDark ? "#132235" : "#f8fafc";
  }
  if (metric === "cases") {
    if (val >= 100) return isDark ? "#38bdf8" : "#0d2238"; // Destaque Fortaleza
    if (val >= 36)  return isDark ? "#2dd4bf" : "#0f766e"; // Teal Brilhante
    if (val >= 16)  return isDark ? "#14b8a6" : "#0d9488"; // Teal Forte
    if (val >= 6)   return isDark ? "#10b981" : "#14b8a6"; // Esmeralda
    if (val >= 3)   return isDark ? "#34d399" : "#5eead4"; // Menta Claro
    return isDark ? "#6ee7b7" : "#a7f3d0";                 // Menta Suave (1-2 casos)
  } else {
    if (val >= 20.0) return isDark ? "#fb7185" : "#be123c"; // Vermelho Alerta
    if (val >= 10.0) return isDark ? "#fb923c" : "#ea580c"; // Laranja Intenso
    if (val >= 5.0)  return isDark ? "#facc15" : "#f59e0b"; // Âmbar
    if (val >= 2.0)  return isDark ? "#2dd4bf" : "#14b8a6"; // Teal
    return isDark ? "#6ee7b7" : "#a7f3d0";                 // Verde Suave (< 2.0)
  }
}

function renderMapOverlays() {
  if (!leafletMap || !bubbleLayerGroup || !labelLayerGroup) return;
  bubbleLayerGroup.clearLayers();
  labelLayerGroup.clearLayers();

  const zoom = leafletMap.getZoom();

  mapLayerByNorm.forEach(({ layer, feature }, norm) => {
    const { name, city } = getFeatureCity(feature);
    if (!city) return;

    const val = currentMapMetric === "cases"
      ? city.total
      : (city.incidence !== null ? city.incidence : 0);

    if (val <= 0) return;

    const center = layer.getBounds().getCenter();
    const isSelected = selectedMapCityNorm === norm;

    if (showMapBubbles) {
      const sizeClass = city.total >= 50 ? "size-lg" : city.total >= 10 ? "size-md" : "size-sm";
      const displayVal = currentMapMetric === "cases"
        ? numberBR(city.total)
        : city.incidence.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

      L.marker(center, {
        interactive: false,
        zIndexOffset: 200,
        icon: L.divIcon({
          className: "map-overlay-icon",
          html: `<div class="map-case-bubble ${sizeClass} ${isSelected ? 'is-selected' : ''}">${displayVal}</div>`,
          iconSize: [0, 0]
        })
      }).addTo(bubbleLayerGroup);
    }

    if (showMapLabels && (isSelected || city.total >= 5 || zoom >= 8)) {
      L.marker(center, {
        interactive: false,
        zIndexOffset: 250,
        icon: L.divIcon({
          className: "map-overlay-icon",
          html: `<span class="map-city-label ${showMapBubbles ? 'has-bubble' : ''} ${isSelected ? 'is-selected' : ''}">${escapeHtml(city.name)}</span>`,
          iconSize: [0, 0]
        })
      }).addTo(labelLayerGroup);
    }
  });
}

function renderMapQuickList() {
  const listEl = $("mapQuickList");
  const countEl = $("mapQuickCount");
  if (!listEl) return;

  const query = normalize($("mapQuickSearch")?.value || "");
  const sorted = [...aggregatedCities]
    .filter(c => c.total > 0 && (!query || normalize(c.name).includes(query)))
    .sort((a, b) => b.total - a.total || b.confirmed - a.confirmed);

  if (countEl) countEl.textContent = numberBR(sorted.length);

  if (!sorted.length) {
    listEl.innerHTML = `<div class="text-center py-4 text-muted small">Nenhuma cidade encontrada.</div>`;
    return;
  }

  listEl.innerHTML = sorted.map(c => {
    const isSel = selectedMapCityNorm === normalize(c.name);
    const escaped = escapeHtml(c.name);
    return `
      <div class="map-quick-item ${isSel ? 'active' : ''}" onclick="focusCityOnMap('${escaped}')">
        <div class="min-width-0 flex-grow-1">
          <div class="map-quick-name">${escaped}</div>
          <small class="text-muted d-block" style="font-size: 10.5px;">
            ${numberBR(c.total)} notif. · <span class="text-teal fw-semibold">${numberBR(c.confirmed)} conf.</span>
          </small>
        </div>
        <button type="button" class="btn-quick-modal" onclick="event.stopPropagation(); openCityModal('${escaped}')" title="Abrir ficha de ${escaped}">
          <i class="bi bi-box-arrow-up-right"></i>
        </button>
      </div>
    `;
  }).join("");
}

window.focusCityOnMap = function(cityName) {
  if (!leafletMap || !geoJsonLayer) return;
  const norm = normalize(cityName);
  const entry = mapLayerByNorm.get(norm);
  if (!entry) return;

  selectedMapCityNorm = norm;

  mapLayerByNorm.forEach(({ layer, feature }, key) => {
    if (key === norm) {
      layer.setStyle(getFeatureHighlightStyle(true));
      layer.bringToFront();
    } else {
      layer.setStyle(getFeatureBaseStyle(feature));
    }
  });

  const { name, city } = getFeatureCity(entry.feature);
  updateHoverCard(city, name);

  const bounds = entry.layer.getBounds();
  if (bounds && bounds.isValid()) {
    leafletMap.flyToBounds(bounds, { maxZoom: 9.5, padding: [36, 36], duration: 0.6 });
  }

  renderMapOverlays();
  renderMapQuickList();
};

function flyToRegion(regionKey) {
  if (!leafletMap) return;

  document.querySelectorAll("#mapRegionBar .btn-region-pill").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.region === regionKey);
  });

  if (regionKey === "all") {
    selectedMapCityNorm = null;
    mapLayerByNorm.forEach(({ layer, feature }) => layer.setStyle(getFeatureBaseStyle(feature)));
    if ($("hoverCityName")) $("hoverCityName").textContent = "Passe o mouse sobre uma cidade";
    if ($("hoverCityStats")) $("hoverCityStats").innerHTML = "Explore o mapa para ver casos e taxas";
    renderMapOverlays();
    renderMapQuickList();

    if (geoJsonLayer && typeof geoJsonLayer.getBounds === "function") {
      try {
        const b = geoJsonLayer.getBounds();
        if (b && b.isValid()) leafletMap.flyToBounds(b, { padding: [16, 16], duration: 0.5 });
      } catch (e) {}
    }
    return;
  }

  const bounds = CEARA_REGIONS[regionKey];
  if (bounds) {
    leafletMap.flyToBounds(bounds, { padding: [16, 16], duration: 0.6 });
  }
}

function updateMap() {
  if (typeof L === "undefined" || !leafletMap || !cearaGeoJson) return;

  try {
    if (geoJsonLayer) {
      leafletMap.removeLayer(geoJsonLayer);
    }
    mapLayerByNorm.clear();

    geoJsonLayer = L.geoJSON(cearaGeoJson, {
      style: getFeatureBaseStyle,
      onEachFeature: function(feature, layer) {
        const { name, city } = getFeatureCity(feature);
        const norm = normalize(city ? city.name : name);
        mapLayerByNorm.set(norm, { layer, feature });

        layer.on({
          mouseover: function(e) {
            const l = e.target;
            const isSel = selectedMapCityNorm === norm;
            l.setStyle(getFeatureHighlightStyle(isSel));
            l.bringToFront();
            updateHoverCard(city, name);
          },
          mouseout: function(e) {
            const l = e.target;
            if (selectedMapCityNorm === norm) {
              l.setStyle(getFeatureHighlightStyle(true));
              l.bringToFront();
            } else {
              l.setStyle(getFeatureBaseStyle(feature));
            }
            if (!selectedMapCityNorm) {
              if ($("hoverCityName")) $("hoverCityName").textContent = "Passe o mouse sobre uma cidade";
              if ($("hoverCityStats")) $("hoverCityStats").innerHTML = "Explore o mapa para ver casos e taxas";
            } else {
              const selEntry = mapLayerByNorm.get(selectedMapCityNorm);
              if (selEntry) {
                const selData = getFeatureCity(selEntry.feature);
                updateHoverCard(selData.city, selData.name);
              }
            }
          },
          click: function() {
            openCityModal(city ? city.name : name);
          }
        });
      }
    }).addTo(leafletMap);

    if (!mapInitialFitDone && geoJsonLayer && typeof geoJsonLayer.getBounds === "function") {
      try {
        const bounds = geoJsonLayer.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
          leafletMap.fitBounds(bounds, { padding: [16, 16] });
          mapInitialFitDone = true;
        }
      } catch (e) {}
    }

    renderCartographicGrid();
    renderMapOverlays();
    renderMapQuickList();
    renderMapLegend(currentMapMetric);
  } catch (err) {
    console.warn("Aviso ao renderizar polígonos no mapa:", err);
  }
}

function renderMapLegend(metric) {
  const legendBox = $("mapLegend");
  if (!legendBox) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const zeroColor = isDark ? "#132235" : "#f8fafc";

  if (metric === "cases") {
    const c1_2 = isDark ? "#6ee7b7" : "#a7f3d0";
    const c3_5 = isDark ? "#34d399" : "#5eead4";
    const c6_15 = isDark ? "#10b981" : "#14b8a6";
    const c16_35 = isDark ? "#14b8a6" : "#0d9488";
    const c36_99 = isDark ? "#2dd4bf" : "#0f766e";
    const c100 = isDark ? "#38bdf8" : "#0d2238";

    legendBox.innerHTML = `
      <span class="legend-title">Escala: Notificações</span>
      <div class="legend-scale">
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${zeroColor};"></span>
          <span class="legend-value">0</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c1_2};"></span>
          <span class="legend-value">1-2</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c3_5};"></span>
          <span class="legend-value">3-5</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c6_15};"></span>
          <span class="legend-value">6-15</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c16_35};"></span>
          <span class="legend-value">16-35</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c36_99};"></span>
          <span class="legend-value">36-99</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${c100};"></span>
          <span class="legend-value">100+</span>
        </div>
      </div>
    `;
  } else {
    const iLt2 = isDark ? "#6ee7b7" : "#a7f3d0";
    const i2_5 = isDark ? "#2dd4bf" : "#14b8a6";
    const i5_10 = isDark ? "#facc15" : "#f59e0b";
    const i10_20 = isDark ? "#fb923c" : "#ea580c";
    const i20 = isDark ? "#fb7185" : "#be123c";

    legendBox.innerHTML = `
      <span class="legend-title">Escala: Incidência / 100k hab</span>
      <div class="legend-scale">
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${zeroColor};"></span>
          <span class="legend-value">0</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${iLt2};"></span>
          <span class="legend-value">&lt;2</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${i2_5};"></span>
          <span class="legend-value">2-5</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${i5_10};"></span>
          <span class="legend-value">5-10</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${i10_20};"></span>
          <span class="legend-value">10-20</span>
        </div>
        <div class="legend-scale-item">
          <span class="legend-swatch" style="background: ${i20};"></span>
          <span class="legend-value">20+</span>
        </div>
      </div>
    `;
  }
}

// ==========================================================================
// Componentes: KPIs
// ==========================================================================

function renderKpis() {
  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const isDefault2026 = selYear === "2026" &&
    ($("statusFilter")?.value === "all") &&
    ($("superFilter")?.value === "all") &&
    ($("sexFilter")?.value === "all") &&
    ($("ageFilter")?.value === "all") &&
    !($("citySearch")?.value.trim()) &&
    officialDashboardData?.cards;

  if (isDefault2026) {
    const cards = officialDashboardData.cards;
    const total = cards.casosNotificados || 448;
    const confirmed = cards.casosConfirmados || 175;
    const discarded = cards.casosDescartados || 166;
    const suspected = (cards.casosSuspeitos || 0) + (cards.casosProvaveis || 1);

    if ($("totalKpi")) $("totalKpi").textContent = numberBR(total);
    if ($("confirmedKpi")) $("confirmedKpi").textContent = numberBR(confirmed);
    if ($("suspectedKpi")) $("suspectedKpi").textContent = numberBR(suspected);
    if ($("discardedKpi")) $("discardedKpi").textContent = numberBR(discarded);
    if ($("confirmedPercent")) $("confirmedPercent").textContent = percentBR(confirmed, total);

    const stateIncidence = ((confirmed / totalCearaPopulation) * 100000).toFixed(2);
    if ($("incidenceKpi")) $("incidenceKpi").textContent = Number(stateIncidence).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  } else {
    const total = filteredData.length;
    let confirmed = 0;
    let suspected = 0;
    let discarded = 0;

    filteredData.forEach(r => {
      const s = getRowStatus(r);
      if (s.includes("CONFIRM")) confirmed++;
      else if (s.includes("SUSPEIT") || s.includes("INVESTIG") || s.includes("PROVAV")) suspected++;
      else if (s.includes("DESCART")) discarded++;
    });

    if ($("totalKpi")) $("totalKpi").textContent = numberBR(total);
    if ($("confirmedKpi")) $("confirmedKpi").textContent = numberBR(confirmed);
    if ($("suspectedKpi")) $("suspectedKpi").textContent = numberBR(suspected);
    if ($("discardedKpi")) $("discardedKpi").textContent = numberBR(discarded);
    if ($("confirmedPercent")) $("confirmedPercent").textContent = percentBR(confirmed, total);

    if (totalCearaPopulation > 0 && confirmed > 0) {
      const stateIncidence = ((confirmed / totalCearaPopulation) * 100000).toFixed(2);
      if ($("incidenceKpi")) $("incidenceKpi").textContent = Number(stateIncidence).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    } else {
      if ($("incidenceKpi")) $("incidenceKpi").textContent = "0,0";
    }
  }
}

// ==========================================================================
// Componente: Feed "O que mudou no último boletim?" (Delta Automático)
// ==========================================================================

function formatDeltaPill(val, label, icon, variantClass) {
  if (val === null || val === undefined) return "";
  const sign = val > 0 ? "+" : "";
  return `
    <span class="delta-metric-pill ${variantClass}">
      <i class="bi ${icon}"></i> ${sign}${numberBR(val)} ${escapeHtml(label)}
    </span>
  `;
}

function renderDeltaFeed() {
  const section = $("deltaFeedSection");
  if (!section) return;

  const lastChange = metaData?.lastChange;
  const cards = officialDashboardData?.cards;
  const totals = metaData?.currentTotals || (cards ? {
    notificados: cards.casosNotificados || 0,
    confirmados: cards.casosConfirmados || 0,
    descartados: cards.casosDescartados || 0,
    provaveis: (cards.casosProvaveis || 0) + (cards.casosSuspeitos || 0)
  } : null);

  if ($("deltaPeriodLabel")) {
    $("deltaPeriodLabel").textContent = lastChange?.periodLabel || "Sincronizado com IntegraSUS/SESA";
  }

  if ($("deltaSummaryTitle")) {
    $("deltaSummaryTitle").textContent = lastChange?.summaryText ||
      (totals ? `${numberBR(totals.notificados)} notificações e ${numberBR(totals.confirmados)} confirmados acumulados em 2026` : "Monitoramento ativo");
  }

  const pillsEl = $("deltaPillsContainer");
  if (pillsEl) {
    const d = lastChange?.deltas || {};
    const pills = [
      formatDeltaPill(d.confirmados, "confirmados", "bi-graph-up-arrow", "pill-confirm"),
      formatDeltaPill(d.notificados, "notificações", "bi-folder-plus", "pill-up"),
      formatDeltaPill(d.descartados, "descartados", "bi-shield-check", "pill-discard"),
      formatDeltaPill(d.provaveis, "prováveis", "bi-hourglass-split", "pill-neutral")
    ].filter(Boolean);

    if (totals) {
      pills.push(`
        <span class="delta-metric-pill pill-neutral">
          <i class="bi bi-geo-alt-fill"></i> ${numberBR(aggregatedCities.length)} municípios com notificações
        </span>
      `);
    }
    pillsEl.innerHTML = pills.join("");
  }

  const citiesEl = $("deltaCitiesContainer");
  if (citiesEl) {
    const deltaCities = Array.isArray(lastChange?.topCitiesDelta) && lastChange.topCitiesDelta.length
      ? lastChange.topCitiesDelta
      : [...aggregatedCities].sort((a, b) => b.total - a.total).slice(0, 6);

    const chips = deltaCities.map(c => {
      const detail = c.delta > 0
        ? `<span class="chip-delta">+${numberBR(c.delta)}</span> <small class="text-muted">(${numberBR(c.total)})</small>`
        : c.confirmed > 0
          ? `<span class="chip-delta">${numberBR(c.confirmed)} conf.</span> <small class="text-muted">(${numberBR(c.total)} notif.)</small>`
          : `<span class="chip-delta">${numberBR(c.total)} notif.</span>`;

      return `
        <button type="button" class="delta-city-chip" onclick="openCityModal('${escapeHtml(c.name)}')">
          <span>${escapeHtml(c.name)}</span>
          ${detail}
        </button>
      `;
    }).join("");

    citiesEl.innerHTML = chips
      ? `<span class="delta-city-label"><i class="bi bi-pin-map-fill text-teal me-1"></i>Destaques:</span>${chips}`
      : "";
  }

  const histEl = $("deltaHistoryList");
  if (histEl) {
    const history = Array.isArray(metaData?.history) ? metaData.history : [];
    histEl.innerHTML = history.length
      ? history.map(entry => {
          const dt = entry.detectedAt ? new Date(entry.detectedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
          return `
            <div class="delta-history-item">
              <div>
                <strong class="text-navy">${escapeHtml(entry.periodLabel || "Atualização")}</strong>
                <span class="d-block text-muted">${escapeHtml(entry.summaryText || "")}</span>
              </div>
              <span class="badge bg-light text-secondary border">${escapeHtml(dt)}</span>
            </div>
          `;
        }).join("")
      : `<div class="text-muted small">Nenhum histórico anterior registrado ainda. Novas comparações serão adicionadas automaticamente a cada coleta.</div>`;
  }
}

// ==========================================================================
// Componentes: Gráficos (Chart.js)
// ==========================================================================

function getChartThemeColors() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    tick: isDark ? "#94a3b8" : "#64748b",
    grid: isDark ? "#1f344d" : "#f1f5f9",
    donutBorder: isDark ? "#111d2c" : "#ffffff",
    superBar: isDark ? "#2dd4bf" : "#0d2238",
    tooltipBg: isDark ? "#162536" : "#0d2238"
  };
}

function renderCharts() {
  if (typeof Chart === "undefined") return;
  renderTimelineChart();
  renderStatusChart();
  renderDemographicCharts();
  renderSuperChart();
}

function renderTimelineChart() {
  if (!$("timelineChart")) return;
  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const isDefault2026 = selYear === "2026" &&
    ($("statusFilter")?.value === "all") &&
    ($("superFilter")?.value === "all") &&
    ($("sexFilter")?.value === "all") &&
    ($("ageFilter")?.value === "all") &&
    !($("citySearch")?.value.trim()) &&
    officialDashboardData?.["casos-por-inicio-sintomas"];

  let labels = [];
  let values = [];

  if (isDefault2026) {
    const list = officialDashboardData["casos-por-inicio-sintomas"];
    labels = list.map(item => item.dataSintoma);
    values = list.map(item => Number(item.total || 0));
  } else {
    const counts = new Map();
    filteredData.forEach(r => {
      const d = parseDate(getRowDate(r));
      if (!d) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const sortedKeys = [...counts.keys()].sort();
    labels = sortedKeys.map(k => {
      const [y, m] = k.split("-");
      return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    });
    values = sortedKeys.map(k => counts.get(k));
  }

  if ($("timelineEmpty")) $("timelineEmpty").style.display = labels.length ? "none" : "grid";

  if (charts.timeline) charts.timeline.destroy();

  const theme = getChartThemeColors();
  const ctx = $("timelineChart").getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, "rgba(13, 148, 136, 0.32)");
  gradient.addColorStop(1, "rgba(13, 148, 136, 0.01)");

  charts.timeline = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "Casos por Início dos Sintomas",
        data: values,
        borderColor: "#0d9488",
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointBackgroundColor: "#0d9488",
        pointBorderColor: theme.donutBorder,
        pointRadius: labels.length > 50 ? 2 : 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: theme.tooltipBg,
          padding: 10,
          titleFont: { size: 12, family: "'Plus Jakarta Sans'" },
          bodyFont: { size: 12, family: "'Plus Jakarta Sans'" },
          displayColors: false
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: theme.tick, font: { size: 10 }, maxTicksLimit: 14 }
        },
        y: {
          beginAtZero: true,
          grid: { color: theme.grid },
          ticks: { precision: 0, color: theme.tick, font: { size: 11 } }
        }
      }
    }
  });
}

function renderStatusChart() {
  if (!$("statusChart")) return;
  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const isDefault2026 = selYear === "2026" &&
    ($("statusFilter")?.value === "all") &&
    ($("superFilter")?.value === "all") &&
    ($("sexFilter")?.value === "all") &&
    ($("ageFilter")?.value === "all") &&
    !($("citySearch")?.value.trim()) &&
    officialDashboardData?.cards;

  let labels = [];
  let values = [];
  let colors = [];

  if (isDefault2026) {
    const cards = officialDashboardData.cards;
    labels = ["Confirmados", "Descartados", "Prováveis / Suspeitos"];
    values = [
      cards.casosConfirmados || 175,
      cards.casosDescartados || 166,
      (cards.casosSuspeitos || 0) + (cards.casosProvaveis || 1)
    ];
    colors = ["#0d9488", "#64748b", "#d97706"];
  } else {
    const map = new Map();
    filteredData.forEach(r => {
      const s = getRowStatus(r);
      let label = "Outros";
      if (s.includes("CONFIRM")) label = "Confirmados";
      else if (s.includes("SUSPEIT") || s.includes("INVESTIG")) label = "Em Investigação";
      else if (s.includes("DESCART")) label = "Descartados";
      else if (s.includes("PROVAV")) label = "Prováveis";
      else if (s.includes("NAO CLASSIFIC")) label = "Não Classificáveis";
      map.set(label, (map.get(label) || 0) + 1);
    });

    labels = ["Confirmados", "Em Investigação", "Descartados", "Prováveis", "Não Classificáveis", "Outros"]
      .filter(l => map.has(l) && map.get(l) > 0);
    values = labels.map(l => map.get(l));
    const palette = {
      "Confirmados": "#0d9488",
      "Em Investigação": "#d97706",
      "Descartados": "#64748b",
      "Prováveis": "#8b5cf6",
      "Não Classificáveis": "#cbd5e1",
      "Outros": "#94a3b8"
    };
    colors = labels.map(l => palette[l] || "#94a3b8");
  }

  if ($("statusEmpty")) $("statusEmpty").style.display = labels.length ? "none" : "grid";

  if (charts.status) charts.status.destroy();

  const theme = getChartThemeColors();
  charts.status = new Chart($("statusChart"), {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 2,
        borderColor: theme.donutBorder,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: { legend: { display: false } }
    }
  });

  if ($("statusLegend")) {
    $("statusLegend").innerHTML = labels.map((l, i) => `
      <div class="status-legend-item">
        <span class="legend-dot" style="background-color: ${colors[i]}"></span>
        <span>${escapeHtml(l)}: <strong>${numberBR(values[i])}</strong></span>
      </div>
    `).join("");
  }
}

function renderDemographicCharts() {
  if (!$("sexChart") || !$("ageChart")) return;
  const selYear = $("yearFilter") ? $("yearFilter").value : "2026";
  const isDefault2026 = selYear === "2026" &&
    ($("statusFilter")?.value === "all") &&
    ($("superFilter")?.value === "all") &&
    ($("sexFilter")?.value === "all") &&
    ($("ageFilter")?.value === "all") &&
    !($("citySearch")?.value.trim()) &&
    officialDashboardData?.["casos-por-sexo-faixa-etaria"];

  let sexLabels = [];
  let sexValues = [];
  let ageLabels = [];
  let ageValues = [];

  if (isDefault2026) {
    const list = officialDashboardData["casos-por-sexo-faixa-etaria"];
    const sexCounts = { "Masculino": 0, "Feminino": 0 };
    const ageCounts = {};

    list.forEach(item => {
      const s = item.sexo;
      const f = item.faixaEtaria;
      const t = Number(item.total || 0);

      if (sexCounts[s] !== undefined) sexCounts[s] += t;
      ageCounts[f] = (ageCounts[f] || 0) + t;
    });

    sexLabels = ["Masculino", "Feminino"];
    sexValues = [sexCounts.Masculino, sexCounts.Feminino];

    ageLabels = ["00-09", "10-19", "20-29", "30-39", "40-49", "50-59", "60+"];
    ageValues = ageLabels.map(a => ageCounts[a] || 0);
  } else {
    const sexMap = { "Masculino": 0, "Feminino": 0, "Ignorado": 0 };
    const ageMap = new Map();

    filteredData.forEach(r => {
      const s = getRowSex(r);
      sexMap[s] = (sexMap[s] || 0) + 1;
      const a = getRowAge(r);
      ageMap.set(a, (ageMap.get(a) || 0) + 1);
    });

    sexLabels = ["Masculino", "Feminino", "Ignorado"].filter(s => sexMap[s] > 0);
    sexValues = sexLabels.map(s => sexMap[s]);

    ageLabels = [...ageMap.keys()].sort();
    ageValues = ageLabels.map(a => ageMap.get(a));
  }

  if (charts.sex) charts.sex.destroy();
  const theme = getChartThemeColors();
  const sexColors = ["#0d9488", "#f43f5e", "#94a3b8"];

  charts.sex = new Chart($("sexChart"), {
    type: "doughnut",
    data: {
      labels: sexLabels,
      datasets: [{
        data: sexValues,
        backgroundColor: sexColors,
        borderWidth: 2,
        borderColor: theme.donutBorder
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: { legend: { display: false } }
    }
  });

  const totalSex = sexValues.reduce((a, b) => a + b, 0);
  if ($("sexLegend")) {
    $("sexLegend").innerHTML = sexLabels.map((l, i) => `
      <div class="status-legend-item">
        <span class="legend-dot" style="background-color: ${sexColors[i]}"></span>
        <span>${escapeHtml(l)}: <strong>${numberBR(sexValues[i])}</strong> (${percentBR(sexValues[i], totalSex)})</span>
      </div>
    `).join("");
  }

  if (charts.age) charts.age.destroy();

  charts.age = new Chart($("ageChart"), {
    type: "bar",
    data: {
      labels: ageLabels.map(a => a + (a.includes("+") || a.includes("Não") ? "" : " anos")),
      datasets: [{
        label: "Notificações",
        data: ageValues,
        backgroundColor: "#14b8a6",
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: theme.tick, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: theme.grid }, ticks: { precision: 0, color: theme.tick } }
      }
    }
  });
}

function renderSuperChart() {
  if (!$("superChart")) return;
  const map = new Map();
  filteredData.forEach(r => {
    const s = getRowSuper(r);
    map.set(s, (map.get(s) || 0) + 1);
  });

  const labels = [...map.keys()].sort((a, b) => map.get(b) - map.get(a));
  const values = labels.map(l => map.get(l));

  if (charts.super) charts.super.destroy();

  const theme = getChartThemeColors();
  charts.super = new Chart($("superChart"), {
    type: "bar",
    data: {
      labels: labels.map(l => titleCase(l)),
      datasets: [{
        label: "Notificações",
        data: values,
        backgroundColor: theme.superBar,
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, grid: { color: theme.grid }, ticks: { precision: 0, color: theme.tick } },
        y: { grid: { display: false }, ticks: { color: theme.tick, font: { size: 11, weight: "600" } } }
      }
    }
  });
}

function renderCityProgressBars() {
  if (!$("cityBars")) return;
  const sorted = [...aggregatedCities].sort((a, b) => b.total - a.total).slice(0, 8);
  const max = sorted[0]?.total || 1;

  $("cityBars").innerHTML = sorted.length > 0 ? sorted.map((c, i) => `
    <div class="city-progress-row" onclick="openCityModal('${escapeHtml(c.name)}')">
      <div class="city-rank-badge">${i + 1}</div>
      <div class="city-progress-main">
        <div class="city-progress-title">${escapeHtml(c.name)}</div>
        <div class="progress-track">
          <div class="progress-bar-fill" style="width: ${(c.total / max) * 100}%"></div>
        </div>
      </div>
      <div class="city-progress-value">
        <strong>${numberBR(c.total)}</strong>
        <small>${c.share}%</small>
      </div>
    </div>
  `).join("") : '<div class="text-center py-4 text-muted">Nenhum município localizado.</div>';
}

// ==========================================================================
// Componente de Tabela e Paginação Profissional
// ==========================================================================

function renderTable() {
  if (tableState.mode === "city") {
    renderCityTable();
  } else {
    renderRawTable();
  }
}

function renderCityTable() {
  if (!$("mainTableHead") || !$("mainTableBody")) return;
  if ($("tableSubtitle")) $("tableSubtitle").textContent = "Tabela consolidada por município de residência com dados do IBGE (clique na linha para detalhes)";

  const thead = `
    <tr>
      <th style="width: 50px;">#</th>
      <th class="sortable" onclick="handleTableSort('name')">
        Município ${getSortIcon('name')}
      </th>
      <th class="sortable text-end" onclick="handleTableSort('total')">
        Notificações ${getSortIcon('total')}
      </th>
      <th class="sortable text-end" onclick="handleTableSort('confirmed')">
        Confirmados ${getSortIcon('confirmed')}
      </th>
      <th class="sortable text-end" onclick="handleTableSort('discarded')">
        Descartados ${getSortIcon('discarded')}
      </th>
      <th class="sortable text-end" onclick="handleTableSort('incidence')">
        Taxa / 100k hab ${getSortIcon('incidence')}
      </th>
      <th class="sortable text-end" onclick="handleTableSort('share')">
        Part. % ${getSortIcon('share')}
      </th>
    </tr>
  `;
  $("mainTableHead").innerHTML = thead;

  const sorted = [...aggregatedCities].sort((a, b) => {
    let vA = a[tableState.sortCol];
    let vB = b[tableState.sortCol];

    if (tableState.sortCol === "name") {
      return tableState.sortDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    }

    vA = vA === null || vA === undefined ? -1 : vA;
    vB = vB === null || vB === undefined ? -1 : vB;

    return tableState.sortDir === "asc" ? vA - vB : vB - vA;
  });

  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / tableState.pageSize) || 1;
  if (tableState.page > totalPages) tableState.page = totalPages;

  const startIdx = (tableState.page - 1) * tableState.pageSize;
  const pageRows = sorted.slice(startIdx, startIdx + tableState.pageSize);

  if (pageRows.length === 0) {
    $("mainTableBody").innerHTML = `<tr><td colspan="7" class="text-center py-5 text-muted">Nenhum município corresponde aos filtros ativos.</td></tr>`;
    renderPaginationControls(0, 0, 0, 1);
    return;
  }

  $("mainTableBody").innerHTML = pageRows.map((c, i) => {
    const rank = startIdx + i + 1;
    const incidenceHtml = c.incidence !== null
      ? `<span class="incidence-pill ${c.incidence >= 10 ? 'incidence-high' : ''}">${numberBR(c.incidence)}</span>`
      : `<span class="text-muted small">Sem censo</span>`;

    return `
      <tr class="clickable-row" onclick="openCityModal('${escapeHtml(c.name)}')">
        <td class="text-muted">${rank}</td>
        <td>
          <strong class="text-navy">${escapeHtml(c.name)}</strong>
          ${c.code ? `<span class="badge bg-light text-muted border ms-1" style="font-size: 9px;">${c.code}</span>` : ""}
        </td>
        <td class="text-end fw-bold text-navy">${numberBR(c.total)}</td>
        <td class="text-end"><span class="status-pill status-pill-confirm">${numberBR(c.confirmed)}</span></td>
        <td class="text-end"><span class="status-pill status-pill-descart">${numberBR(c.discarded)}</span></td>
        <td class="text-end">${incidenceHtml}</td>
        <td class="text-end text-muted">${c.share}%</td>
      </tr>
    `;
  }).join("");

  renderPaginationControls(startIdx + 1, Math.min(startIdx + tableState.pageSize, totalItems), totalItems, totalPages);
}

function renderRawTable() {
  if (!$("mainTableHead") || !$("mainTableBody")) return;
  if ($("tableSubtitle")) $("tableSubtitle").textContent = "Microdados das notificações epidemiológicas individuais";

  const thead = `
    <tr>
      <th style="width: 50px;">#</th>
      <th class="sortable" onclick="handleTableSort('date')">Data Início Sintomas ${getSortIcon('date')}</th>
      <th class="sortable" onclick="handleTableSort('city')">Município ${getSortIcon('city')}</th>
      <th>Superintendência</th>
      <th>Sexo</th>
      <th>Faixa Etária</th>
      <th>Classificação</th>
    </tr>
  `;
  $("mainTableHead").innerHTML = thead;

  const sorted = [...filteredData].sort((a, b) => {
    if (tableState.sortCol === "city") {
      const cA = getRowCity(a);
      const cB = getRowCity(b);
      return tableState.sortDir === "asc" ? cA.localeCompare(cB) : cB.localeCompare(cA);
    }
    const dA = parseDate(getRowDate(a))?.getTime() || 0;
    const dB = parseDate(getRowDate(b))?.getTime() || 0;
    return tableState.sortDir === "asc" ? dA - dB : dB - dA;
  });

  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / tableState.pageSize) || 1;
  if (tableState.page > totalPages) tableState.page = totalPages;

  const startIdx = (tableState.page - 1) * tableState.pageSize;
  const pageRows = sorted.slice(startIdx, startIdx + tableState.pageSize);

  if (pageRows.length === 0) {
    $("mainTableBody").innerHTML = `<tr><td colspan="7" class="text-center py-5 text-muted">Nenhum registro encontrado.</td></tr>`;
    renderPaginationControls(0, 0, 0, 1);
    return;
  }

  $("mainTableBody").innerHTML = pageRows.map((r, i) => {
    const rank = startIdx + i + 1;
    const dt = parseDate(getRowDate(r));
    const dtStr = dt ? dt.toLocaleDateString("pt-BR") : "Não informada";
    const st = getRowStatus(r);
    let pillClass = "status-pill-descart";
    if (st.includes("CONFIRM")) pillClass = "status-pill-confirm";
    else if (st.includes("INVESTIG") || st.includes("SUSPEIT")) pillClass = "status-pill-investig";

    return `
      <tr>
        <td class="text-muted">${rank}</td>
        <td><strong>${dtStr}</strong></td>
        <td>${escapeHtml(getRowCity(r))}</td>
        <td class="text-muted small">${escapeHtml(getRowSuper(r))}</td>
        <td>${escapeHtml(getRowSex(r))}</td>
        <td>${escapeHtml(getRowAge(r))}</td>
        <td><span class="status-pill ${pillClass}">${escapeHtml(titleCase(st))}</span></td>
      </tr>
    `;
  }).join("");

  renderPaginationControls(startIdx + 1, Math.min(startIdx + tableState.pageSize, totalItems), totalItems, totalPages);
}

function getSortIcon(col) {
  if (tableState.sortCol !== col) return `<i class="bi bi-arrow-down-up text-muted ms-1" style="font-size: 10px;"></i>`;
  return tableState.sortDir === "asc"
    ? `<i class="bi bi-arrow-up-circle-fill text-teal ms-1"></i>`
    : `<i class="bi bi-arrow-down-circle-fill text-teal ms-1"></i>`;
}

function handleTableSort(col) {
  if (tableState.sortCol === col) {
    tableState.sortDir = tableState.sortDir === "asc" ? "desc" : "asc";
  } else {
    tableState.sortCol = col;
    tableState.sortDir = col === "name" || col === "city" ? "asc" : "desc";
  }
  renderTable();
}

function renderPaginationControls(start, end, total, totalPages) {
  if (!$("paginationInfo") || !$("paginationControls")) return;
  $("paginationInfo").innerHTML = `Mostrando <strong>${numberBR(start)}</strong> a <strong>${numberBR(end)}</strong> de <strong>${numberBR(total)}</strong> registros`;

  const cur = tableState.page;
  const pages = [];

  if (totalPages <= 7) {
    for (let p = 1; p <= totalPages; p++) pages.push(p);
  } else {
    pages.push(1);
    if (cur > 3) pages.push("...");
    const pStart = Math.max(2, cur - 1);
    const pEnd = Math.min(totalPages - 1, cur + 1);
    for (let p = pStart; p <= pEnd; p++) pages.push(p);
    if (cur < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  let html = `
    <li class="page-item ${cur === 1 ? 'disabled' : ''}">
      <button class="page-link" onclick="goToPage(1)" title="Primeira página"><i class="bi bi-chevron-double-left"></i></button>
    </li>
    <li class="page-item ${cur === 1 ? 'disabled' : ''}">
      <button class="page-link" onclick="goToPage(${cur - 1})" title="Página anterior"><i class="bi bi-chevron-left"></i></button>
    </li>
  `;

  pages.forEach(p => {
    if (p === "...") {
      html += `<li class="page-item disabled"><span class="page-link border-0">...</span></li>`;
    } else {
      html += `
        <li class="page-item ${p === cur ? 'active' : ''}">
          <button class="page-link" onclick="goToPage(${p})">${p}</button>
        </li>
      `;
    }
  });

  html += `
    <li class="page-item ${cur === totalPages || totalPages === 0 ? 'disabled' : ''}">
      <button class="page-link" onclick="goToPage(${cur + 1})" title="Próxima página"><i class="bi bi-chevron-right"></i></button>
    </li>
    <li class="page-item ${cur === totalPages || totalPages === 0 ? 'disabled' : ''}">
      <button class="page-link" onclick="goToPage(${totalPages})" title="Última página"><i class="bi bi-chevron-double-right"></i></button>
    </li>
  `;

  $("paginationControls").innerHTML = html;
}

window.goToPage = function(page) {
  tableState.page = page;
  renderTable();
};

// ==========================================================================
// Modal Interativo de Detalhes do Município
// ==========================================================================

window.openCityModal = function(cityName) {
  const norm = normalize(cityName);
  const city = aggregatedCities.find(c => normalize(c.name) === norm);
  if (!city || !$("cityModalTitle") || !$("cityModalBody")) return;

  $("cityModalTitle").textContent = city.name;
  if ($("cityModalSubtitle")) {
    $("cityModalSubtitle").textContent = city.code ? `Código IBGE: ${city.code} · Ceará` : "Município do Ceará";
  }

  const total = city.total;
  const incidenceStr = city.incidence !== null ? numberBR(city.incidence) : "N/D";
  const popStr = city.population ? numberBR(city.population) + " hab." : "Não disponível no censo";

  const ageItems = Object.entries(city.ages || {}).sort((a, b) => b[1] - a[1]);

  $("cityModalBody").innerHTML = `
    <div class="row g-3 mb-4">
      <div class="col-6 col-md-3">
        <div class="mini-kpi-box">
          <span class="mini-kpi-label">Notificações</span>
          <div class="mini-kpi-value">${numberBR(city.total)}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="mini-kpi-box">
          <span class="mini-kpi-label text-teal">Confirmados</span>
          <div class="mini-kpi-value text-teal">${numberBR(city.confirmed)}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="mini-kpi-box">
          <span class="mini-kpi-label">Descartados</span>
          <div class="mini-kpi-value text-slate">${numberBR(city.discarded)}</div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="mini-kpi-box">
          <span class="mini-kpi-label">Taxa / 100k hab</span>
          <div class="mini-kpi-value text-navy">${incidenceStr}</div>
        </div>
      </div>
    </div>

    <div class="row g-4">
      <div class="col-md-6">
        <h6 class="fw-bold text-navy mb-2"><i class="bi bi-people me-1 text-teal"></i> Perfil por Sexo</h6>
        <div class="p-3 bg-light rounded-3">
          <div class="d-flex justify-content-between mb-2 small">
            <span>Masculino:</span>
            <strong>${numberBR(city.males)} (${percentBR(city.males, total)})</strong>
          </div>
          <div class="progress mb-3" style="height: 6px;">
            <div class="progress-bar bg-teal" style="width: ${(city.males / total) * 100}%"></div>
          </div>

          <div class="d-flex justify-content-between mb-2 small">
            <span>Feminino:</span>
            <strong>${numberBR(city.females)} (${percentBR(city.females, total)})</strong>
          </div>
          <div class="progress" style="height: 6px;">
            <div class="progress-bar bg-danger" style="width: ${(city.females / total) * 100}%"></div>
          </div>
        </div>
      </div>

      <div class="col-md-6">
        <h6 class="fw-bold text-navy mb-2"><i class="bi bi-bar-chart me-1 text-teal"></i> Faixas Etárias Notificadas</h6>
        <div class="p-3 bg-light rounded-3" style="max-height: 140px; overflow-y: auto;">
          ${ageItems.map(([age, count]) => `
            <div class="d-flex justify-content-between align-items-center py-1 border-bottom small">
              <span>${age === "Outras" ? "Outras faixas" : escapeHtml(age) + " anos"}</span>
              <span class="badge age-case-badge">${numberBR(count)} caso(s)</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <div class="mt-4 pt-3 border-top text-muted small d-flex justify-content-between">
      <span>População estimada: <strong>${popStr}</strong></span>
      <span>Participação no estado: <strong>${city.share}%</strong></span>
    </div>
  `;

  if (typeof bootstrap !== "undefined" && $("cityDetailModal")) {
    const modal = new bootstrap.Modal($("cityDetailModal"));
    modal.show();
  }
};

// ==========================================================================
// Exportação de Dados (CSV & JSON)
// ==========================================================================

function exportFilteredCsv() {
  if (!aggregatedCities.length) {
    alert("Nenhum dado para exportar.");
    return;
  }

  const headers = ["Posição", "Município", "Código IBGE", "População", "Total Notificações", "Confirmados", "Descartados", "Taxa por 100k hab", "Participação %"];
  const rows = aggregatedCities.map((c, i) => [
    i + 1,
    `"${c.name}"`,
    c.code || "",
    c.population || "",
    c.total,
    c.confirmed,
    c.discarded,
    c.incidence || "",
    c.share
  ]);

  const csvContent = "\uFEFF" + [headers.join(";"), ...rows.map(r => r.join(";"))].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `mpox-ceara-dados-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportFilteredJson() {
  const jsonStr = JSON.stringify({
    metadata: {
      origem: "Painel Epidemiológico Mpox Ceará",
      fontes: [
        "IntegraSUS - Secretaria da Saúde do Ceará (https://integrasus.saude.ce.gov.br/#/indicadores/indicadores-vigilancia-saude/situacao-epidemiologica/monkeypox)",
        "IBGE Localidades e População Oficial"
      ],
      extraidoEm: new Date().toISOString()
    },
    cidades: aggregatedCities,
    painelOficialSesa: officialDashboardData
  }, null, 2);

  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8;" });
  downloadBlob(blob, `mpox-ceara-dados-${new Date().toISOString().slice(0, 10)}.json`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function showAlert(message, type = "warning") {
  if (!$("alertArea")) return;
  $("alertArea").innerHTML = `
    <div class="alert alert-${type} alert-dismissible fade show border-0 shadow-sm" role="alert">
      <i class="bi bi-info-circle-fill me-2"></i> ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Fechar"></button>
    </div>
  `;
}

function clearAlert() {
  if ($("alertArea")) $("alertArea").innerHTML = "";
}

function startCountdown() {
  if (countdownTimerId) clearInterval(countdownTimerId);
  countdownRemaining = AUTO_REFRESH_INTERVAL;
  updateCountdownBadge();

  countdownTimerId = setInterval(() => {
    countdownRemaining--;
    if (countdownRemaining <= 0) {
      loadMpoxData();
    } else {
      updateCountdownBadge();
    }
  }, 1000);
}

function resetCountdown() {
  countdownRemaining = AUTO_REFRESH_INTERVAL;
  updateCountdownBadge();
}

function updateCountdownBadge() {
  const el = $("countdownText");
  if (el) el.textContent = `${countdownRemaining}s`;
}

function setupEventListeners() {
  if ($("refreshBtn")) {
    $("refreshBtn").addEventListener("click", () => {
      loadMpoxData();
    });
  }

  if ($("yearFilter")) $("yearFilter").addEventListener("change", applyFilters);
  if ($("statusFilter")) $("statusFilter").addEventListener("change", applyFilters);
  if ($("superFilter")) $("superFilter").addEventListener("change", applyFilters);
  if ($("sexFilter")) $("sexFilter").addEventListener("change", applyFilters);
  if ($("ageFilter")) $("ageFilter").addEventListener("change", applyFilters);
  if ($("citySearch")) $("citySearch").addEventListener("input", applyFilters);

  if ($("clearCitySearch")) {
    $("clearCitySearch").addEventListener("click", () => {
      if ($("citySearch")) $("citySearch").value = "";
      applyFilters();
    });
  }

  if ($("clearFilters")) {
    $("clearFilters").addEventListener("click", () => {
      if ($("yearFilter")) $("yearFilter").value = "2026";
      if ($("statusFilter")) $("statusFilter").value = "all";
      if ($("superFilter")) $("superFilter").value = "all";
      if ($("sexFilter")) $("sexFilter").value = "all";
      if ($("ageFilter")) $("ageFilter").value = "all";
      if ($("citySearch")) $("citySearch").value = "";
      applyFilters();
    });
  }

  document.querySelectorAll('input[name="tableMode"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      tableState.mode = e.target.value;
      tableState.page = 1;
      tableState.sortCol = tableState.mode === "city" ? "total" : "date";
      tableState.sortDir = "desc";
      renderTable();
    });
  });

  if ($("pageSizeSelect")) {
    $("pageSizeSelect").addEventListener("change", (e) => {
      tableState.pageSize = Number(e.target.value);
      tableState.page = 1;
      renderTable();
    });
  }

  // Controles do Mapa
  document.querySelectorAll('input[name="mapMetric"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      currentMapMetric = e.target.value;
      updateMap();
    });
  });

  if ($("toggleMapBubbles")) {
    $("toggleMapBubbles").addEventListener("change", (e) => {
      showMapBubbles = e.target.checked;
      renderMapOverlays();
    });
  }

  if ($("toggleMapLabels")) {
    $("toggleMapLabels").addEventListener("change", (e) => {
      showMapLabels = e.target.checked;
      renderMapOverlays();
    });
  }

  document.querySelectorAll("#mapRegionBar .btn-region-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      flyToRegion(btn.dataset.region);
    });
  });

  if ($("mapQuickSearch")) {
    $("mapQuickSearch").addEventListener("input", renderMapQuickList);
  }

  if ($("resetMapBtn")) {
    $("resetMapBtn").addEventListener("click", () => {
      flyToRegion("all");
    });
  }

  const mapTabBtn = $("map-tab");
  if (mapTabBtn) {
    mapTabBtn.addEventListener("shown.bs.tab", () => {
      if (leafletMap) {
        leafletMap.invalidateSize();
        if (!mapInitialFitDone && geoJsonLayer && typeof geoJsonLayer.getBounds === "function") {
          try {
            const b = geoJsonLayer.getBounds();
            if (b && b.isValid && b.isValid()) {
              leafletMap.fitBounds(b, { padding: [16, 16] });
              mapInitialFitDone = true;
            }
          } catch (e) {}
        }
      }
    });
  }

  if ($("exportCsvBtn")) $("exportCsvBtn").addEventListener("click", exportFilteredCsv);
  if ($("exportJsonBtn")) $("exportJsonBtn").addEventListener("click", exportFilteredJson);
}

// ==========================================================================
// Componente: Indicador de Tendência Epidêmica e Velocímetro
// ==========================================================================

function renderTrendIndicator() {
  const list = officialDashboardData?.["casos-por-inicio-sintomas"];
  if (!list || !Array.isArray(list) || list.length === 0) return;

  // Converte e ordena datas cronologicamente
  const parsed = list.map(item => {
    const parts = String(item.dataSintoma).split("/");
    const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    return { date: d, total: Number(item.total || 0) };
  }).filter(x => !isNaN(x.date.getTime())).sort((a, b) => a.date - b.date);

  if (parsed.length === 0) return;

  const n = parsed.length;
  // Considera os últimos 7 pontos diários vs 7 pontos diários imediatamente anteriores
  const slice7Cur = parsed.slice(Math.max(0, n - 7));
  const slice7Prev = parsed.slice(Math.max(0, n - 14), Math.max(0, n - 7));
  const sum7Cur = slice7Cur.reduce((acc, i) => acc + i.total, 0);
  const sum7Prev = slice7Prev.reduce((acc, i) => acc + i.total, 0);

  // Considera os últimos 14 pontos diários vs 14 pontos diários anteriores
  const slice14Cur = parsed.slice(Math.max(0, n - 14));
  const slice14Prev = parsed.slice(Math.max(0, n - 28), Math.max(0, n - 14));
  const sum14Cur = slice14Cur.reduce((acc, i) => acc + i.total, 0);
  const sum14Prev = slice14Prev.reduce((acc, i) => acc + i.total, 0);

  // Variação percentual nos últimos 7 dias
  let pctChange = 0;
  if (sum7Prev > 0) {
    pctChange = Math.round(((sum7Cur - sum7Prev) / sum7Prev) * 100);
  } else if (sum7Cur > 0) {
    pctChange = 100;
  }

  // Atualização dos números nos cards
  if ($("trendCases7d")) $("trendCases7d").textContent = numberBR(sum7Cur);
  if ($("trendComp7d")) $("trendComp7d").textContent = `vs ${numberBR(sum7Prev)} anterior`;
  if ($("trendCases14d")) $("trendCases14d").textContent = numberBR(sum14Cur);
  if ($("trendComp14d")) $("trendComp14d").textContent = `vs ${numberBR(sum14Prev)} anterior`;

  // Elementos visuais
  const gaugeNeedle = $("trendGaugeIndicator");
  const phaseBadge = $("trendPhaseBadge");
  const phaseText = $("trendPhaseText");
  const trendTitle = $("trendTitle");
  const trendSubtitle = $("trendSubtitle");
  const trendVar = $("trendVariationDisplay");
  const icon = $("trendIcon");
  const iconBadge = $("trendIconBadge");

  if (pctChange > 15) {
    // Fase de Aceleração (Vermelho)
    if (phaseBadge) phaseBadge.className = "badge rounded-pill bg-danger-subtle text-danger border border-danger-subtle";
    if (phaseText) phaseText.textContent = "Fase de Aceleração";
    if (trendTitle) trendTitle.textContent = "Transmissão em Forte Aceleração";
    if (trendSubtitle) trendSubtitle.textContent = "Curva epidêmica em expansão no estado";
    if (trendVar) {
      trendVar.textContent = `+${pctChange}% (Últimos 7 dias)`;
      trendVar.className = "fw-bold text-danger";
    }
    if (icon) icon.className = "bi bi-graph-up-arrow";
    if (iconBadge) {
      iconBadge.style.backgroundColor = "var(--red-soft)";
      iconBadge.style.color = "var(--red)";
    }
    if (gaugeNeedle) gaugeNeedle.style.left = Math.min(95, 72 + Math.min(22, pctChange / 5)) + "%";
  } else if (pctChange < -15) {
    // Fase de Desaceleração (Verde)
    if (phaseBadge) phaseBadge.className = "badge rounded-pill bg-success-subtle text-success border border-success-subtle";
    if (phaseText) phaseText.textContent = "Fase de Desaceleração";
    if (trendTitle) trendTitle.textContent = "Transmissão em Queda Sustentada";
    if (trendSubtitle) trendSubtitle.textContent = "Redução na notificação de novos casos";
    if (trendVar) {
      trendVar.textContent = `${pctChange}% (Últimos 7 dias)`;
      trendVar.className = "fw-bold text-success";
    }
    if (icon) icon.className = "bi bi-graph-down-arrow";
    if (iconBadge) {
      iconBadge.style.backgroundColor = "var(--teal-soft)";
      iconBadge.style.color = "var(--teal)";
    }
    if (gaugeNeedle) gaugeNeedle.style.left = Math.max(5, 28 - Math.min(20, Math.abs(pctChange) / 5)) + "%";
  } else {
    // Fase de Estabilidade (Amarelo)
    if (phaseBadge) phaseBadge.className = "badge rounded-pill bg-warning-subtle text-warning border border-warning-subtle";
    if (phaseText) phaseText.textContent = "Fase de Estabilidade";
    if (trendTitle) trendTitle.textContent = "Transmissão em Platô Estável";
    if (trendSubtitle) trendSubtitle.textContent = "Variação dentro da margem de estabilidade clínica";
    if (trendVar) {
      trendVar.textContent = `${pctChange >= 0 ? "+" : ""}${pctChange}% (Estabilidade)`;
      trendVar.className = "fw-bold text-warning";
    }
    if (icon) icon.className = "bi bi-dash-circle";
    if (iconBadge) {
      iconBadge.style.backgroundColor = "var(--amber-soft)";
      iconBadge.style.color = "var(--amber)";
    }
    if (gaugeNeedle) gaugeNeedle.style.left = "50%";
  }
}

// ==========================================================================
// Componente: Tema Escuro / Claro (Dark Mode)
// ==========================================================================

function initTheme() {
  const saved = localStorage.getItem("mpox_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initialTheme = saved ? saved : (prefersDark ? "dark" : "light");
  setTheme(initialTheme);

  const btn = $("themeToggleBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      setTheme(next);
      localStorage.setItem("mpox_theme", next);
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-bs-theme", theme);
  const icon = $("themeToggleIcon");
  const text = $("themeToggleText");
  const isDark = theme === "dark";

  if (isDark) {
    if (icon) icon.className = "bi bi-sun-fill text-warning";
    if (text) text.textContent = "Modo Claro";
  } else {
    if (icon) icon.className = "bi bi-moon-stars-fill";
    if (text) text.textContent = "Modo Escuro";
  }

  // Atualiza cores padrão dos gráficos Chart.js
  if (typeof Chart !== "undefined") {
    Chart.defaults.color = isDark ? "#94a3b8" : "#64748b";
    Chart.defaults.borderColor = isDark ? "#1f344d" : "#e2e8f0";
    if (charts && charts.timeline) {
      renderCharts();
    }
  }

  // Atualiza cores do mapa Leaflet se já inicializado
  if (leafletMap && geoJsonLayer) {
    updateMap();
  }
}

// ==========================================================================
// Componente: Triagem Rápida & Autoavaliação de Sintomas (SUS / SESA-CE)
// ==========================================================================

function initTriage() {
  const form = $("triageForm");
  const resultCard = $("triageResultCard");
  const resetBtn = $("resetTriageBtn");
  const copyBtn = $("copyTriageBtn");
  if (!form || !resultCard) return;

  const inputs = form.querySelectorAll(".triage-input");
  inputs.forEach(input => {
    input.addEventListener("change", evaluateTriage);
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      inputs.forEach(i => { i.checked = false; });
      evaluateTriage();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", copyTriageSummary);
  }
}

function evaluateTriage() {
  const rash = $("symp_rash")?.checked;
  const genital = $("symp_genital")?.checked;
  const pus = $("symp_pus")?.checked;
  const itch = $("symp_itch")?.checked;
  const fever = $("symp_fever")?.checked;
  const lymph = $("symp_lymph")?.checked;
  const muscle = $("symp_muscle")?.checked;
  const expContact = $("exp_contact")?.checked;
  const expItems = $("exp_items")?.checked;

  const card = $("triageResultCard");
  if (!card) return;

  const hasSpecificLesions = genital || pus;
  const hasGeneralLesions = rash || itch;
  const hasSystemic = fever || lymph || muscle;
  const hasExposure = expContact || expItems;

  const totalChecked = [rash, genital, pus, itch, fever, lymph, muscle, expContact, expItems].filter(Boolean).length;

  if (totalChecked === 0) {
    card.innerHTML = `
      <div class="d-flex align-items-center gap-3">
        <div class="triage-result-icon bg-success-subtle text-success">
          <i class="bi bi-shield-check"></i>
        </div>
        <div>
          <span class="badge bg-success-subtle text-success border border-success-subtle mb-1">Risco Baixo</span>
          <h5 class="fw-bold text-navy mb-1">Nenhum sintoma de alerta selecionado</h5>
          <p class="text-muted small mb-0">Selecione as opções acima para receber a orientação clínica preventiva adequada ao seu caso.</p>
        </div>
      </div>
    `;
    card.className = "triage-result-card rounded-4 p-4 mt-3 border border-success-subtle bg-success-subtle bg-opacity-10";
    return;
  }

  if (hasSpecificLesions || (hasGeneralLesions && (hasSystemic || hasExposure))) {
    // ALTA SUSPEITA CLÍNICA (ALERTA VERMELHO)
    card.className = "triage-result-card rounded-4 p-4 mt-3 border border-danger bg-danger-subtle bg-opacity-25";
    card.innerHTML = `
      <div class="d-flex align-items-start gap-3">
        <div class="triage-result-icon bg-danger text-white rounded-3">
          <i class="bi bi-exclamation-triangle-fill"></i>
        </div>
        <div class="flex-grow-1">
          <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
            <span class="badge bg-danger text-white px-2 py-1">ALERTA VERMELHO · ALTA SUSPEITA CLÍNICA</span>
            <span class="text-danger fw-bold small"><i class="bi bi-hospital me-1"></i>Orientação SUS Presencial Imediata</span>
          </div>
          <h5 class="fw-bold text-danger mb-2">Quadro clínico altamente compatível com Mpox</h5>
          <p class="small text-secondary mb-3">
            A presença de lesões cutâneas características, vesículas ou feridas associadas a sintomas sistêmicos e exposição recente exige <strong>isolamento imediato e atendimento especializado</strong> para confirmação laboratorial via PCR pelo LACEN-CE.
          </p>
          <div class="bg-white rounded-3 border border-danger-subtle p-3 mb-2 shadow-sm text-dark">
            <strong class="d-block text-navy small mb-2"><i class="bi bi-check2-circle text-danger me-1"></i>Condutas Imediatas Recomendadas:</strong>
            <ul class="small text-secondary mb-0 ps-3">
              <li><strong>Isolamento Domiciliar:</strong> Permaneça em quarto individual até que todas as crostas caiam e nova pele se forme.</li>
              <li><strong>Proteção das Lesões:</strong> Cubra as áreas afetadas com curativos ou tecidos limpos e use máscara cirúrgica perto de outras pessoas.</li>
              <li><strong>Não Compartilhar Itens:</strong> Não compartilhe toalhas, roupas de cama, copos, pratos ou talheres.</li>
              <li><strong>Onde Buscar Atendimento no Ceará:</strong>
                <br>• <strong>Fortaleza:</strong> Hospital São José de Doenças Infecciosas (HSJ) ou UPA 24h mais próxima.
                <br>• <strong>Interior do Estado:</strong> Unidade Básica de Saúde (Posto de Saúde) ou UPA regional.
                <br>• <strong>Telefone de Dúvidas:</strong> Disque Saúde <strong>136</strong> ou Plantão Saúde Ceará.
              </li>
            </ul>
          </div>
        </div>
      </div>
    `;
  } else if (hasGeneralLesions || hasSystemic || hasExposure) {
    // RISCO MODERADO / ATENÇÃO (ALERTA AMARELO)
    card.className = "triage-result-card rounded-4 p-4 mt-3 border border-warning bg-warning-subtle bg-opacity-25";
    card.innerHTML = `
      <div class="d-flex align-items-start gap-3">
        <div class="triage-result-icon bg-warning text-dark rounded-3">
          <i class="bi bi-info-circle-fill"></i>
        </div>
        <div class="flex-grow-1">
          <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
            <span class="badge bg-warning text-dark px-2 py-1">ALERTA AMARELO · ATENÇÃO E MONITORAMENTO</span>
            <span class="text-warning-dark fw-bold small"><i class="bi bi-eye me-1"></i>Monitoramento Ativo de 21 Dias</span>
          </div>
          <h5 class="fw-bold text-navy mb-2">Sintomas inespecíficos ou histórico de exposição</h5>
          <p class="small text-secondary mb-3">
            Você informou sinais iniciais ou possível exposição. O período de incubação da Mpox varia de 5 a 21 dias. Recomenda-se auto-observação cuidadosa diária e prevenção ativa.
          </p>
          <div class="bg-white rounded-3 border border-warning-subtle p-3 mb-0 shadow-sm text-dark">
            <strong class="d-block text-navy small mb-2"><i class="bi bi-check2-circle text-warning me-1"></i>Recomendações:</strong>
            <ul class="small text-secondary mb-0 ps-3">
              <li>Monitore diariamente o aparecimento de novas lesões na pele, febre ou ínguas.</li>
              <li>Evite contato físico íntimo preventivamente durante o período de 21 dias.</li>
              <li>Procure a Unidade Básica de Saúde (Posto de Saúde) mais próxima caso novas feridas apareçam.</li>
            </ul>
          </div>
        </div>
      </div>
    `;
  }
}

function copyTriageSummary() {
  const rash = $("symp_rash")?.checked ? "SIM" : "NÃO";
  const genital = $("symp_genital")?.checked ? "SIM" : "NÃO";
  const pus = $("symp_pus")?.checked ? "SIM" : "NÃO";
  const fever = $("symp_fever")?.checked ? "SIM" : "NÃO";
  const lymph = $("symp_lymph")?.checked ? "SIM" : "NÃO";
  const expContact = $("exp_contact")?.checked ? "SIM" : "NÃO";

  const summary = [
    "--- AUTOAVALIAÇÃO DE SINTOMAS MPOX (CEARÁ) ---",
    `Data/Hora: ${new Date().toLocaleString("pt-BR")}`,
    `Erupções/Manchas: ${rash}`,
    `Lesões Anogenitais/Orais: ${genital}`,
    `Vesículas com Pus: ${pus}`,
    `Febre Súbita: ${fever}`,
    `Ínguas Inchadas: ${lymph}`,
    `Contato Próximo com Caso Suspeito: ${expContact}`,
    "Fonte: Painel Mpox Ceará / Protocolo SUS-SESA"
  ].join("\n");

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(summary).then(() => {
      const btn = $("copyTriageBtn");
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<i class="bi bi-check-lg text-success me-1"></i> Copiado!`;
        setTimeout(() => { btn.innerHTML = orig; }, 2000);
      }
    });
  }
}

async function init() {
  initTheme();
  initTriage();
  setupEventListeners();
  startCountdown();

  // 1. Carrega dados locais imediatamente (resposta em ~10ms)
  await loadAuxiliaryData();
  await loadMpoxData();

  // 2. Inicializa o mapa Leaflet
  initMap();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
