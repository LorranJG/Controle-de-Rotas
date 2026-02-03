const STORAGE_KEY = "entregas_v6";

// Base fixa
const BASE_NAME = "GUARULHOS";
const BASE_QUERY = "Guarulhos, SP, Brasil"; // usado no geocoding
let base = null; // { lat, lng, city }

// Leaflet
const map = L.map('map').setView([-23.5505, -46.6333], 10);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let deliveries = [];        // SOMENTE entregas do meio: [{ id, lat, lng, city }]
let markers = new Map();    // id -> marker
let routeLine = null;
let searchMarker = null;

let baseStartMarker = null;
let baseEndMarker = null;

// Cache simples para evitar excesso de chamadas
let routeCacheKey = "";
let routeCache = {
  km: 0,
  geojson: null
};

// ---------- Utils ----------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function setBulkStatus(text) {
  const el = document.getElementById("bulkStatus");
  if (el) el.textContent = text;
}

// ---------- Storage ----------
function save() {
  const kmpl = Number(document.getElementById("kmpl")?.value || 0);
  const payload = { deliveries, kmpl };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    deliveries = (parsed?.deliveries || []).map(d => ({
      id: d.id || uid(),
      lat: Number(d.lat),
      lng: Number(d.lng),
      city: (d.city || "")
    }));

    const kmpl = Number(parsed?.kmpl || 0);
    if (kmpl > 0 && document.getElementById("kmpl")) {
      document.getElementById("kmpl").value = String(kmpl);
    }
  } catch {
    deliveries = [];
  }
}

// ---------- Distância (fallback linha reta) ----------
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => deg * Math.PI / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLng*sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

// Paradas completas: base -> entregas -> base
function stops() {
  if (!base) return [];
  return [
    { id: "BASE_START", lat: base.lat, lng: base.lng, city: BASE_NAME },
    ...deliveries,
    { id: "BASE_END", lat: base.lat, lng: base.lng, city: BASE_NAME }
  ];
}

// fallback linha reta (se OSRM falhar)
function totalKmStraight() {
  const s = stops();
  if (s.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < s.length - 1; i++) {
    sum += haversineKm(s[i], s[i + 1]);
  }
  return sum;
}

// ---------- ROTA REAL (OSRM) ----------
function buildRouteKey() {
  // key muda se mudar ordem/pontos
  const s = stops();
  return s.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join("|");
}

async function fetchOsrmRoute() {
  const s = stops();
  if (s.length < 2) return { km: 0, geojson: null };

  // OSRM: coords = lon,lat;lon,lat;...
  const coords = s.map(p => `${p.lng},${p.lat}`).join(";");

  // geometries=geojson para desenhar; overview=full para rota completa
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json" }
  });

  if (!res.ok) throw new Error("Falha OSRM");
  const data = await res.json();

  const meters = data?.routes?.[0]?.distance || 0;
  const geojson = data?.routes?.[0]?.geometry || null;

  return { km: meters / 1000, geojson };
}

async function getRoadRouteCached() {
  const key = buildRouteKey();
  if (key && key === routeCacheKey && routeCache.geojson) {
    return routeCache;
  }

  routeCacheKey = key;

  try {
    const r = await fetchOsrmRoute();
    routeCache = { km: r.km, geojson: r.geojson };
    return routeCache;
  } catch (e) {
    console.warn("OSRM falhou, usando linha reta:", e);
    routeCache = { km: totalKmStraight(), geojson: null };
    return routeCache;
  }
}

// ---------- Cidade / Geocoding ----------
function pickCityFromAddress(addr) {
  return (
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.county ||
    addr.state ||
    ""
  );
}

async function reverseCity(lat, lng) {
  const url =
    "https://nominatim.openstreetmap.org/reverse?" +
    new URLSearchParams({
      format: "jsonv2",
      lat: String(lat),
      lon: String(lng),
      zoom: "10",
      addressdetails: "1"
    });

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "pt-BR"
    }
  });

  if (!res.ok) return "";
  const data = await res.json();
  const city = pickCityFromAddress(data.address || {});
  return (city || "").toUpperCase();
}

async function searchPlace(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      addressdetails: "1"
    });

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Language": "pt-BR"
    }
  });

  if (!res.ok) throw new Error("Falha na busca");
  const data = await res.json();
  if (!data || data.length === 0) return null;

  const item = data[0];
  const addr = item.address || {};
  const city = pickCityFromAddress(addr);

  return {
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
    display: item.display_name,
    city: (city || "").toUpperCase()
  };
}

// ---------- Base GUARULHOS ----------
async function initBase() {
  const place = await searchPlace(BASE_QUERY);
  if (!place) throw new Error("Não foi possível localizar a base GUARULHOS");
  base = { lat: place.lat, lng: place.lng, city: BASE_NAME };

  if (baseStartMarker) map.removeLayer(baseStartMarker);
  if (baseEndMarker) map.removeLayer(baseEndMarker);

  // Mantive dois markers como você tinha (sobrepostos), mas ok.
  // Se quiser, dá pra deixar só 1.
  baseStartMarker = L.marker([base.lat, base.lng]).addTo(map).bindPopup(`Base Inicial (${BASE_NAME})`);
  baseEndMarker = L.marker([base.lat, base.lng]).addTo(map).bindPopup(`Base Final (${BASE_NAME})`);

  map.setView([base.lat, base.lng], 10);
}

// ---------- UI / Render ----------
async function updateSummary() {
  // Se você quer contar paradas totais (base + entregas + base):
  // const totalStops = stops().length;

  // Aqui, o mais comum é mostrar quantidade de ENTREGAS
  document.getElementById("count").textContent = String(deliveries.length);

  const road = await getRoadRouteCached();
  document.getElementById("km").textContent = (road.km || 0).toFixed(2);

  const kmpl = Number(document.getElementById("kmpl")?.value || 0);
  const liters = (!kmpl || kmpl <= 0) ? 0 : (road.km / kmpl);
  document.getElementById("liters").textContent = liters.toFixed(2);
}

async function drawRouteLine() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }

  const s = stops();
  if (s.length < 2) return;

  const road = await getRoadRouteCached();

  // Se tiver geojson, desenha rota real; senão desenha linha reta fallback
  if (road.geojson) {
    routeLine = L.geoJSON(road.geojson).addTo(map);
  } else {
    const latlngs = s.map(d => [d.lat, d.lng]);
    routeLine = L.polyline(latlngs).addTo(map);
  }
}

function syncMarkerTitles() {
  deliveries.forEach((d, idx) => {
    const m = markers.get(d.id);
    if (m) {
      const label = `Entrega ${idx + 1}${d.city ? ` (${d.city})` : ""}`;
      m.setPopupContent(label);
    }
  });
}

function renderList() {
  const ol = document.getElementById("list");
  ol.innerHTML = "";

  // Base inicial
  const liStart = document.createElement("li");
  liStart.className = "item";
  liStart.innerHTML = `
    <div>
      <strong>Base Inicial (${BASE_NAME})</strong><br>
      <code>${base.lat.toFixed(6)}, ${base.lng.toFixed(6)}</code>
    </div>
    <div class="btns">
      <button data-action="focus" data-id="BASE_START">Ver</button>
    </div>
  `;
  ol.appendChild(liStart);

  // Entregas
  deliveries.forEach((d, idx) => {
    const li = document.createElement("li");
    li.className = "item";
    li.setAttribute("draggable", "true");
    li.dataset.index = String(idx);

    li.innerHTML = `
      <div>
        <strong>Entrega ${idx + 1}${d.city ? ` (${d.city})` : ""}</strong><br>
        <code>${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}</code>
      </div>
      <div class="btns">
        <button data-action="focus" data-id="${d.id}">Ver</button>
        <button data-action="remove" data-id="${d.id}">Remover</button>
      </div>
    `;
    ol.appendChild(li);
  });

  // Base final
  const liEnd = document.createElement("li");
  liEnd.className = "item";
  liEnd.innerHTML = `
    <div>
      <strong>Base Final (${BASE_NAME})</strong><br>
      <code>${base.lat.toFixed(6)}, ${base.lng.toFixed(6)}</code>
    </div>
    <div class="btns">
      <button data-action="focus" data-id="BASE_END">Ver</button>
    </div>
  `;
  ol.appendChild(liEnd);

  // Botões
  ol.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");

      if (action === "remove") removeDelivery(id);
      if (action === "focus") focusStop(id);
    });
  });

  // Drag & drop
  wireDragAndDrop(ol);

  syncMarkerTitles();

  // Rota mudou: invalida cache (porque stops mudou)
  routeCacheKey = "";

  // Atualiza UI (async, sem travar render)
  (async () => {
    await updateSummary();
    await drawRouteLine();
  })();

  save();
}

function focusStop(id) {
  if (id === "BASE_START" || id === "BASE_END") {
    map.setView([base.lat, base.lng], Math.max(map.getZoom(), 12));
    if (id === "BASE_START" && baseStartMarker) baseStartMarker.openPopup();
    if (id === "BASE_END" && baseEndMarker) baseEndMarker.openPopup();
    return;
  }

  const d = deliveries.find(x => x.id === id);
  if (!d) return;
  map.setView([d.lat, d.lng], Math.max(map.getZoom(), 15));
  const m = markers.get(id);
  if (m) m.openPopup();
}

// ---------- Entregas ----------
function addDelivery(latlng, city = "") {
  const d = { id: uid(), lat: latlng.lat, lng: latlng.lng, city: (city || "") };
  deliveries.push(d);

  const marker = L.marker([d.lat, d.lng], { draggable: true }).addTo(map);
  markers.set(d.id, marker);

  marker.on("dragend", async (e) => {
    const p = e.target.getLatLng();
    d.lat = p.lat;
    d.lng = p.lng;
    d.city = (await reverseCity(d.lat, d.lng)) || d.city;
    renderList();
  });

  if (!d.city) {
    reverseCity(d.lat, d.lng).then((c) => {
      d.city = c || "";
      renderList();
    });
  }

  renderList();
}

function removeDelivery(id) {
  deliveries = deliveries.filter(d => d.id !== id);

  const m = markers.get(id);
  if (m) {
    map.removeLayer(m);
    markers.delete(id);
  }

  renderList();
}

function clearAll() {
  deliveries = [];
  markers.forEach(m => map.removeLayer(m));
  markers.clear();

  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (searchMarker) {
    map.removeLayer(searchMarker);
    searchMarker = null;
  }

  routeCacheKey = "";
  routeCache = { km: 0, geojson: null };

  renderList();
}

// ---------- Drag & drop (somente entregas do meio) ----------
function moveDelivery(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const item = deliveries.splice(fromIndex, 1)[0];
  deliveries.splice(toIndex, 0, item);
  renderList();
}

function wireDragAndDrop(ol) {
  let dragIndex = null;

  const items = Array.from(ol.querySelectorAll(".item[draggable='true']"));

  items.forEach((li) => {
    li.addEventListener("dragstart", () => {
      dragIndex = Number(li.dataset.index);
      li.classList.add("dragging");
    });

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      items.forEach(x => x.classList.remove("drag-over"));
      dragIndex = null;
    });

    li.addEventListener("dragover", (e) => reminds(e));

    function reminds(e) {
      e.preventDefault();
      li.classList.add("drag-over");
    }

    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
    });

    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const dropIndex = Number(li.dataset.index);
      li.classList.remove("drag-over");
      if (dragIndex === null) return;
      moveDelivery(dragIndex, dropIndex);
    });
  });
}

// ---------- Busca (input) ----------
async function handleSearch() {
  const input = document.getElementById("q");
  const query = input.value.trim();
  if (!query) return;

  try {
    const place = await searchPlace(query);
    if (!place) {
      alert("Não encontrei. Tente 'Cidade - UF' ou um endereço mais completo.");
      return;
    }

    map.setView([place.lat, place.lng], 13);

    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([place.lat, place.lng]).addTo(map);
    searchMarker.bindPopup(place.display).openPopup();

    const add = document.getElementById("addAsDelivery").checked;
    if (add) addDelivery({ lat: place.lat, lng: place.lng }, place.city || "");
  } catch (err) {
    console.error(err);
    alert("Erro na busca. Pode ser limite do serviço. Tente novamente em alguns segundos.");
  }
}

// ---------- Lote ----------
async function addBulk() {
  const ta = document.getElementById("bulkText");
  const raw = (ta?.value || "").trim();

  if (!raw) {
    setBulkStatus("Cole as linhas primeiro.");
    return;
  }

  const lines = raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    setBulkStatus("Nada para processar.");
    return;
  }

  setBulkStatus(`Processando ${lines.length} linha(s)...`);

  let ok = 0, fail = 0;

  for (let i = 0; i < lines.length; i++) {
    const q = lines[i];
    setBulkStatus(`Buscando (${i + 1}/${lines.length}): ${q}`);

    try {
      const place = await searchPlace(q);
      if (!place) { fail++; continue; }

      addDelivery({ lat: place.lat, lng: place.lng }, place.city || "");
      ok++;

      map.setView([place.lat, place.lng], Math.max(map.getZoom(), 10));
    } catch (e) {
      console.error(e);
      fail++;
    }

    // respeita limites do Nominatim / evita spam
    await sleep(900);
  }

  setBulkStatus(`Concluído: ${ok} adicionadas • ${fail} falharam.`);
}

// ---------- Eventos ----------
document.getElementById("btnAdd").addEventListener("click", () => {
  const c = map.getCenter();
  addDelivery({ lat: c.lat, lng: c.lng });
});

document.getElementById("btnClear").addEventListener("click", clearAll);

document.getElementById("btnSearch").addEventListener("click", handleSearch);
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch();
});

document.getElementById("btnBulkAdd").addEventListener("click", addBulk);
document.getElementById("btnBulkClear").addEventListener("click", () => {
  const ta = document.getElementById("bulkText");
  if (ta) ta.value = "";
  setBulkStatus("Texto limpo.");
});

document.getElementById("kmpl").addEventListener("input", () => {
  // recalcula e salva (async sem travar)
  (async () => {
    routeCacheKey = "";
    await updateSummary();
    save();
  })();
});

// Clique no mapa: adiciona entrega (no meio)
map.on("click", (e) => addDelivery(e.latlng));

// ---------- Inicialização ----------
(async function boot() {
  load();
  await initBase();

  // recriar markers das entregas
  deliveries.forEach(d => {
    const marker = L.marker([d.lat, d.lng], { draggable: true }).addTo(map);
    markers.set(d.id, marker);

    marker.on("dragend", async (e) => {
      const p = e.target.getLatLng();
      d.lat = p.lat;
      d.lng = p.lng;
      d.city = (await reverseCity(d.lat, d.lng)) || d.city;
      renderList();
    });

    if (!d.city) {
      reverseCity(d.lat, d.lng).then((c) => {
        d.city = c || "";
        renderList();
      });
    }
  });

  renderList();
  setBulkStatus("Cole linhas e clique em “Adicionar em lote”.");
})();
