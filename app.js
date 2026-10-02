const $ = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const areas = { kalibo: [11.7054, 122.3679], numancia: [11.710899, 122.330451], newWashington: [11.6528, 122.4324] };
const supplier = { name: 'Kalibo ice depot · sample', position: [11.7052, 122.3633] };
const facilities = [supplier, { name: 'Numancia ice depot · sample', position: [11.6950, 122.3280] }, { name: 'Cold-storage hub · sample', position: [11.6926, 122.3784] }];
const initialRequests = () => [
  { id: 'demo-1', name: 'Kalibo fisher group', area: 'Kalibo', position: [11.7168, 122.3790], kg: 180, window: 'Within 1 hour', done: false },
  { id: 'demo-2', name: 'Numancia delivery · sample', area: 'Numancia', position: [...areas.numancia], kg: 140, window: 'Within 2 hours', done: false },
  { id: 'demo-3', name: 'New Washington fish hub', area: 'New Washington', position: areas.newWashington, kg: 100, window: 'Today', done: false }
];
let requests = initialRequests();
try {
  const saved = JSON.parse(localStorage.getItem('yeloroute-requests'));
  if (Array.isArray(saved) && saved.length <= 100 && saved.every(r => typeof r.id === 'string' && typeof r.name === 'string' && typeof r.area === 'string' && typeof r.window === 'string' && Number.isFinite(r.kg) && r.kg > 0 && r.kg <= 1250 && Array.isArray(r.position) && r.position.length === 2 && r.position.every(Number.isFinite))) requests = saved;
} catch { /* A private browser may disable storage; the demo still works in memory. */ }
let map, baseLayer, routeLayer, vehicleMarker, requestMarkers = [], timer, progress = 0, toastTimer;
let satelliteActive = false;
let roadRoute, routeStatus = 'loading', routeVersion = 0, routeController, routeDebounce, lastRoutingRequest = 0;
const routeCache = new Map(), imageryKeys = { maptiler: '', esri: '' };
let activeImageryProvider = '', plannedSignature = '', selectedKeyProvider = 'maptiler', routeMessage = '', editingRequestId = '', pickingLocation = false;
const formatDistance = metres => `${(metres / 1000).toFixed(1)} km`;
const formatDuration = seconds => `${Math.max(1, Math.ceil(seconds / 60))} min`;
const total = () => requests.reduce((sum, request) => sum + request.kg, 0);
function notify(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function persist() { try { localStorage.setItem('yeloroute-requests', JSON.stringify(requests)); } catch {} }
function markerIcon(type, label) {
  const vehicle = type === 'vehicle';
  return L.divIcon({ className: 'map-marker', html: `<div class="marker-bubble ${type}">${vehicle ? '<img src="truck.svg" alt="Ice delivery truck">' : label}</div>`, iconSize: vehicle ? [44, 44] : [36, 36], iconAnchor: vehicle ? [22, 22] : [18, 18] });
}
function initializeMap() {
  if (!window.L) { $('map').innerHTML = '<div class="map-fallback">Map library unavailable<small>Check your connection, then reload. The dispatch board still works.</small></div>'; $('mapState').textContent = 'Map unavailable'; return; }
  $('map').innerHTML = '';
  map = L.map('map', { zoomControl: false, maxZoom: 22 }).setView([11.692, 122.372], 12);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  $('mapCredits').appendChild(map.attributionControl.getContainer());
  baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  let tileWarning = false;
  baseLayer.on('tileerror', () => { if (!tileWarning) { tileWarning = true; notify('Street tiles unavailable. Check your connection; sample markers remain usable.'); } });
  facilities.forEach((facility, index) => L.marker(facility.position, { icon: markerIcon(index === 2 ? 'storage' : 'supplier', index === 2 ? '▦' : '❄') }).addTo(map).bindPopup(`<strong>${facility.name}</strong><br><small>${index === 0 ? '750 kg ice available' : index === 1 ? '500 kg ice available' : '800 kg storage available'} · demo data</small>`));
  vehicleMarker = L.marker(supplier.position, { icon: markerIcon('vehicle', '▰'), zIndexOffset: 1000 }).addTo(map).bindPopup('<strong>YR–01 · Demo vehicle</strong><br><small>Simulated location. No live GPS.</small>');
  renderMap(); fitMap();
  map.attributionControl.addAttribution('Routes: <a href="https://project-osrm.org/">OSRM</a> / <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
  map.on('click', event => {
    if (!pickingLocation) return;
    $('stopLatitude').value = event.latlng.lat.toFixed(6); $('stopLongitude').value = event.latlng.lng.toFixed(6);
    cancelLocationPick(); $('locationDialog').showModal();
  });
}
function renderMap() {
  if (!map) return;
  requestMarkers.forEach(marker => marker.remove());
  requestMarkers = requests.map((request, index) => {
    const access = roadRoute?.waypoints[index + 1];
    // Retain the entered destination. Moving its marker onto another road hides location errors.
    return L.marker(request.position, { icon: markerIcon('pickup', request.done ? '✓' : index + 1) }).addTo(map).bindPopup(`<strong>${escapeHTML(request.name)}</strong><br><small>${request.kg} kg ice · ${escapeHTML(request.window)}<br>${request.locationUpdated ? 'Dispatcher-selected access point' : 'Unverified sample location'}${access ? `<br>Matched road is ${Math.round(access.distance || 0)} m from this pin` : ''}</small><br><button class="popup-edit-location" data-edit-location="${escapeHTML(request.id)}">Correct access point</button>`);
  });
  if (routeLayer) routeLayer.remove();
  routeLayer = undefined;
  if (roadRoute) routeLayer = L.layerGroup([
    L.polyline(roadRoute.points, { color: '#ffffff', weight: 9, opacity: .95, lineCap: 'round', lineJoin: 'round', smoothFactor: 0, interactive: false, className: 'road-outline' }),
    L.polyline(roadRoute.points, { color: '#087ff5', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', smoothFactor: 0, interactive: false, className: 'road-main' })
  ]).addTo(map);
}
function fitMap() { if (map) map.fitBounds(L.latLngBounds([...facilities.map(f => f.position), ...requests.map(r => r.position), ...(roadRoute?.points || [])]), { paddingTopLeft: [48, 35], paddingBottomRight: [48, 100] }); }
function renderRouteStatus(message) {
  if (message !== undefined) routeMessage = message;
  $('routeBadge').textContent = routeStatus === 'ready' ? 'ROAD ROUTE READY' : routeStatus === 'loading' ? 'CALCULATING' : 'ROUTE UNAVAILABLE';
  $('routeBadge').className = `route-badge ${routeStatus}`;
  $('routeLabel').textContent = routeStatus === 'ready' ? 'Road route' : routeStatus === 'loading' ? 'Preparing road route' : 'Road route unavailable';
  $('routeCaption').textContent = ' · OSRM / OpenStreetMap';
  $('routeDistance').textContent = roadRoute ? formatDistance(roadRoute.distance) : '—';
  $('routeDuration').textContent = roadRoute ? formatDuration(roadRoute.duration) : '—';
  $('routeHelp').textContent = routeMessage || (roadRoute ? 'Driving estimate in listed stop order. Traffic, loading and delivery windows are not included.' : 'Finding roads between your delivery stops.');
  const maximumSnap = roadRoute ? Math.max(...roadRoute.waypoints.map(w => w.distance || 0)) : 0;
  $('snapNotice').hidden = maximumSnap <= 30;
  $('snapNotice').textContent = `A delivery pin is ${Math.round(maximumSnap)} m from the matched road. Verify its vehicle entrance before field use.`;
  $('simulate').disabled = total() > 600 || !roadRoute || !map;
  $('refreshRoute').disabled = routeStatus === 'loading';
}
function scheduleRoadRoute() {
  const points = [supplier.position, ...requests.map(r => r.position)], signature = JSON.stringify(points);
  if (plannedSignature === signature) return;
  plannedSignature = signature; clearTimeout(routeDebounce); routeController?.abort(); routeVersion++;
  restartSimulation(); roadRoute = undefined; routeStatus = 'loading'; routeMessage = ''; renderMap(); renderRouteStatus();
  routeDebounce = setTimeout(() => loadRoadRoute(points, routeVersion), 300);
}
async function loadRoadRoute(points, version) {
  if (version !== routeVersion) return;
  try {
    const url = YeloRouting.routeURL(points), cached = routeCache.get(url);
    let parsed;
    if (cached && Date.now() - cached.savedAt < 120000) parsed = cached.route;
    else {
      const wait = Math.max(0, 1100 - (Date.now() - lastRoutingRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (version !== routeVersion) return;
      routeController = new AbortController(); lastRoutingRequest = Date.now();
      const response = await fetch(url, { signal: AbortSignal.any([routeController.signal, AbortSignal.timeout(18000)]), headers: { Accept: 'application/json' } });
      if (!response.ok) {
        if (response.status === 400) {
          const failure = await response.json().catch(() => null);
          if (failure?.code === 'NoSegment' || failure?.code === 'NoRoute') YeloRouting.parseRoute(failure, points.length);
        }
        throw new Error(response.status === 429 ? 'The routing service is busy. Wait a moment, then recalculate.' : `Routing service returned HTTP ${response.status}. Recalculate when the connection is available.`);
      }
      parsed = YeloRouting.parseRoute(await response.json(), points.length);
      if (version !== routeVersion) return;
      if (routeCache.size >= 5) routeCache.delete(routeCache.keys().next().value);
      routeCache.set(url, { route: parsed, savedAt: Date.now() });
    }
    if (version !== routeVersion) return;
    roadRoute = parsed; routeStatus = 'ready'; routeMessage = ''; render(); updateProgress();
  } catch (error) {
    if (version !== routeVersion) return;
    roadRoute = undefined; routeStatus = 'error'; renderMap();
    renderRouteStatus(error.name === 'TimeoutError' ? 'Road routing timed out. Check your connection and recalculate.' : error instanceof TypeError ? 'Cannot reach the routing service. Check your connection and recalculate.' : error.message);
  }
}
function drivingInstructions(leg) {
  if (!leg?.steps) return '';
  const descriptions = leg.steps.filter(step => step.distance > 15 || step.maneuver?.type === 'arrive').map(step => {
    const maneuver = step.maneuver || {}, road = step.name ? ` onto ${step.name}` : '';
    if (maneuver.type === 'arrive') return 'Arrive at the mapped road access point.';
    const action = maneuver.type === 'depart' ? 'Depart' : maneuver.type === 'roundabout' || maneuver.type === 'rotary' ? `Take the roundabout${maneuver.exit ? ` exit ${maneuver.exit}` : ''}` : maneuver.type === 'turn' ? `Turn ${maneuver.modifier || ''}` : maneuver.type === 'end of road' ? `At the road end, turn ${maneuver.modifier || ''}` : maneuver.type === 'fork' ? `Keep ${maneuver.modifier || ''} at the fork` : 'Continue';
    return `${action}${road} · ${step.distance < 1000 ? `${Math.round(step.distance)} m` : formatDistance(step.distance)}`;
  });
  return `<details class="driver-directions"><summary>Road directions · ${formatDistance(leg.distance)} / ${formatDuration(leg.duration)}</summary><ol>${descriptions.map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ol></details>`;
}
function render() {
  const load = total();
  $('requested').innerHTML = `${load.toLocaleString()} <small>kg</small>`;
  $('requestCount').textContent = `${requests.length} delivery requests`;
  $('stopCount').textContent = `${requests.length} stops`;
  $('load').textContent = `${load} / 600 kg`;
  $('loadBar').style.width = `${Math.min(100, load / 600 * 100)}%`;
  $('loadBar').style.background = load > 600 ? '#df8b35' : '#119783';
  $('capacityWarning').hidden = load <= 600;
  $('capacityWarning').textContent = `Load exceeds capacity by ${load - 600} kg. Split this run before dispatch. Simulation is paused.`;
  $('stops').innerHTML = requests.map((r, i) => `<div class="stop ${r.done ? 'done' : ''}"><span class="stop-number">${r.done ? '✓' : i + 1}</span><div><strong>${escapeHTML(r.name)}</strong><p>${escapeHTML(r.area)} · ${r.done ? 'Handover recorded' : escapeHTML(r.window)}</p>${roadRoute?.legs[i] ? `<div class="leg-estimate">${formatDistance(roadRoute.legs[i].distance)} · ~${formatDuration(roadRoute.legs[i].duration)} from previous stop</div>` : ''}<button class="edit-location" data-edit-location="${escapeHTML(r.id)}">${r.locationUpdated ? 'Edit access point' : 'Set accurate location'}</button></div><span class="qty">${r.kg} kg</span></div>`).join('');
  $('driverStops').innerHTML = requests.map((r, i) => `<article class="driver-stop ${r.done ? 'completed' : ''}"><h3>${i + 1}. ${escapeHTML(r.name)}</h3><p>${escapeHTML(r.area)} · ${r.kg} kg ice · ${escapeHTML(r.window)}</p><button class="button ${r.done ? '' : 'primary'}" data-complete="${escapeHTML(r.id)}">${r.done ? '✓ Recorded · undo' : 'Record demo handover'}</button>${roadRoute ? drivingInstructions(roadRoute.legs[i]) : ''}</article>`).join('');
  renderMap();
  renderRouteStatus();
  if (map) setTimeout(() => map.invalidateSize?.({ pan: false }), 0);
}
function stopSimulation() { clearInterval(timer); timer = undefined; $('simulate').textContent = progress >= 100 ? '↻ Replay simulation' : '▶ Start simulation'; }
function restartSimulation() { stopSimulation(); progress = 0; updateProgress(); $('vehicleStatus').textContent = 'Ready for simulation'; }
function updateProgress() {
  $('progress').value = progress; $('progressText').textContent = `${Math.round(progress)}%`;
  if (!vehicleMarker) return;
  const position = roadRoute ? YeloRouting.positionAt(roadRoute, progress / 100) : supplier.position;
  vehicleMarker.setLatLng(position);
  if (roadRoute && $('followVehicle').checked && progress > 0 && !document.body.classList.contains('driver-mode')) map.panTo(position, { animate: true, duration: .35 });
}
$('simulate').addEventListener('click', () => {
  if (total() > 600 || !roadRoute) return;
  if (timer) { stopSimulation(); $('vehicleStatus').textContent = 'Simulation paused'; return; }
  if (progress >= 100) restartSimulation();
  $('simulate').textContent = 'Ⅱ Pause simulation'; $('vehicleStatus').textContent = 'Simulated vehicle moving';
  timer = setInterval(() => { progress = Math.min(100, progress + 1); updateProgress(); if (progress >= 100) { stopSimulation(); $('vehicleStatus').textContent = 'Simulation finished'; notify('Demo route finished. Record handovers in Driver view.'); } }, 450);
});
$('fit').addEventListener('click', fitMap);
$('detailView').addEventListener('click', () => { if (map) map.setView([11.7025, 122.3675], 18); });
$('refreshRoute').addEventListener('click', () => { plannedSignature = ''; scheduleRoadRoute(); });
$('reset').addEventListener('click', () => { requests = initialRequests(); persist(); restartSimulation(); render(); scheduleRoadRoute(); fitMap(); notify('Sample requests and vehicle position reset.'); });
function showView(driver) { document.body.classList.toggle('driver-mode', driver); $('driverPanel').hidden = !driver; $('pageTitle').textContent = driver ? 'Driver workspace' : 'Dispatch overview'; $('dispatchView').classList.toggle('active', !driver); $('driverView').classList.toggle('active', driver); if (!driver && map) setTimeout(() => map.invalidateSize(), 0); }
$('driverView').addEventListener('click', () => showView(true));
$('dispatchView').addEventListener('click', () => showView(false));
$('driverStops').addEventListener('click', event => { const button = event.target.closest('[data-complete]'); if (!button) return; const request = requests.find(r => r.id === button.dataset.complete); if (!request) return; request.done = !request.done; persist(); render(); notify(request.done ? 'Demo handover recorded on this device.' : 'Demo handover undone.'); });
$('newRequest').addEventListener('click', () => $('requestDialog').showModal());
$('requestForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('requestForm').reportValidity()) return;
  const name = $('requestName').value.trim(); if (!name) { $('requestName').setCustomValidity('Enter a request label.'); $('requestName').reportValidity(); return; }
  if (requests.length >= 100) { notify('Demo limit reached. Reset the sample data to add more requests.'); return; }
  const area = $('requestLocation').selectedOptions[0].textContent;
  requests.push({ id: crypto.randomUUID(), name, area, kg: Number($('requestKg').value), window: $('requestWindow').value, position: [...areas[$('requestLocation').value]], done: false });
  persist(); restartSimulation(); scheduleRoadRoute(); render(); fitMap(); $('requestDialog').close(); $('requestForm').reset(); notify('Sample delivery added. Recalculating its road route.');
});
$('requestName').addEventListener('input', () => $('requestName').setCustomValidity(''));
function openLocationEditor(id) {
  const request = requests.find(item => item.id === id);
  if (!request) return;
  editingRequestId = id; cancelLocationPick();
  $('locationTitle').textContent = `Correct ${request.area} location`;
  $('stopName').value = request.name;
  $('stopLatitude').value = request.position[0].toFixed(6); $('stopLongitude').value = request.position[1].toFixed(6);
  $('locationError').textContent = '';
  $('locationDialog').showModal();
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-edit-location]');
  if (button) openLocationEditor(button.dataset.editLocation);
});
function cancelLocationPick() {
  pickingLocation = false; $('locationPickBanner').hidden = true;
  $('map').classList.remove('picking-location');
}
$('cancelLocationPick').addEventListener('click', cancelLocationPick);
$('pickLocation').addEventListener('click', () => {
  if (!map) { $('locationError').textContent = 'The map must be available to choose a location.'; return; }
  const request = requests.find(item => item.id === editingRequestId);
  if (!request) return;
  stopSimulation(); $('vehicleStatus').textContent = 'Simulation paused for location correction';
  $('locationDialog').close(); showView(false); map.closePopup();
  pickingLocation = true; $('locationPickBanner').hidden = false; $('map').classList.add('picking-location');
  map.setView(request.position, 16);
});
$('locationForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('locationForm').reportValidity()) return;
  const request = requests.find(item => item.id === editingRequestId);
  if (!request) return;
  const name = $('stopName').value.trim(), lat = Number($('stopLatitude').value), lon = Number($('stopLongitude').value);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { $('locationError').textContent = 'Enter a stop name and valid latitude/longitude.'; return; }
  const moved = YeloRouting.distance(request.position, [lat, lon]) > 1;
  request.name = name; request.position = [lat, lon]; request.locationUpdated = true;
  if (moved) request.done = false;
  persist(); plannedSignature = ''; scheduleRoadRoute(); render(); cancelLocationPick(); $('locationDialog').close();
  map?.setView([lat, lon], 16); notify('Access point saved. Recalculating the route to your selected location.');
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
function openSettings() { $('keyError').textContent = ''; $('settingsDialog').showModal(); }
$('settings').addEventListener('click', openSettings);
$('satellite').addEventListener('click', () => satelliteActive ? null : openSettings());
$('street').addEventListener('click', () => {
  if (!map) return;
  if (baseLayer) baseLayer.remove();
  baseLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  map.setMaxZoom(19);
  satelliteActive = false; $('street').classList.add('selected'); $('satellite').classList.remove('selected'); $('mapState').textContent = 'Street map'; $('maptilerLogo').hidden = true;
});
function updateProviderSettings() {
  imageryKeys[selectedKeyProvider] = $('apiKey').value.trim();
  selectedKeyProvider = $('imageryProvider').value;
  $('apiKey').value = imageryKeys[selectedKeyProvider];
  const esri = selectedKeyProvider === 'esri';
  $('keyLabel').textContent = esri ? 'ArcGIS Location Platform API key' : 'MapTiler public API key';
  $('providerHelp').textContent = esri ? 'Requires an ArcGIS Location Platform account and a key with basemap access. The published allowance is 2 million basemap tiles per month; usage above the allowance is billed. Configure allowed referrers in your account.' : 'Use your MapTiler key with localhost as an allowed origin. Free plan quotas and usage terms apply.';
  $('providerSignup').href = esri ? 'https://location.arcgis.com/' : 'https://cloud.maptiler.com/';
  $('providerSignup').textContent = esri ? 'Get an ArcGIS Location Platform key ↗' : 'Get a MapTiler key ↗';
  $('keyError').textContent = '';
}
$('imageryProvider').addEventListener('change', updateProviderSettings);
function providerError(status, provider) {
  const name = provider === 'esri' ? 'Esri' : 'MapTiler';
  const messages = {
    400: 'The provider rejected the request. Recopy the API key without spaces or quotes.',
    401: 'This API key was not accepted. Copy the generated key from your provider account.',
    403: provider === 'esri' ? 'Esri denied access. Check basemap privileges, allowed referrers and account status.' : `MapTiler denied access. Check that the key is active, Allowed HTTP Origins includes "${location.hostname}", and Allowed user-agent header is blank.`,
    404: 'The satellite dataset was not found. Check availability in your provider account.',
    429: 'A rate or usage limit was reached. Check account usage before retrying.',
    498: 'Esri did not accept this token. Use a current ArcGIS Location Platform key with basemap access.',
    499: 'Esri requires a valid access token for this imagery service.'
  };
  return `${name} ${status}: ${messages[status] || (status >= 500 ? 'The imagery provider is temporarily unavailable. Try again later.' : 'The provider rejected the connection. Check your account and key settings.')}`;
}
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const key = $('apiKey').value.trim();
  const provider = $('imageryProvider').value;
  if (!key) { $('keyError').textContent = `Enter your ${provider === 'esri' ? 'ArcGIS Location Platform' : 'MapTiler'} key first.`; return; }
  if (/^https?:\/\//i.test(key)) { $('keyError').textContent = 'Paste only the API key, not a map URL.'; return; }
  if (!map) { $('keyError').textContent = 'Reload with an internet connection so the map library can load.'; return; }
  $('saveKey').disabled = true; $('saveKey').textContent = 'Connecting…'; $('keyError').textContent = '';
  try {
    const esri = provider === 'esri';
    const service = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer';
    const metadataURL = esri ? `${service}?f=json&token=${encodeURIComponent(key)}` : `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${encodeURIComponent(key)}`;
    const response = await fetch(metadataURL, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(providerError(response.status, provider));
    const metadata = await response.json();
    if (metadata.error) throw new Error(providerError(metadata.error.code, provider));
    let tileURL, nativeZoom, attribution;
    if (esri) {
      if (!metadata.tileInfo?.lods?.length) throw new Error('Esri did not return imagery metadata. Check your key privileges.');
      tileURL = `${service}/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`;
      nativeZoom = Math.min(22, Math.max(...metadata.tileInfo.lods.map(level => level.level)));
      attribution = `<a href="https://www.esri.com/">Powered by Esri</a> · ${escapeHTML(metadata.copyrightText || 'Esri, Vantor, Earthstar Geographics, and the GIS User Community')}`;
    } else {
      if (!Array.isArray(metadata.tiles) || !metadata.tiles.length) throw new Error('MapTiler did not return satellite tiles.');
      const template = metadata.tiles[0];
      if (new URL(template.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0')).origin !== 'https://api.maptiler.com') throw new Error('Unexpected satellite tile provider.');
      tileURL = template.includes('key=') ? template : `${template}${template.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
      nativeZoom = Math.min(22, metadata.maxzoom ?? 19);
      attribution = metadata.attribution || '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>';
    }
    const satellite = L.tileLayer(tileURL, { minZoom: esri ? 0 : metadata.minzoom ?? 0, maxNativeZoom: nativeZoom, maxZoom: nativeZoom, attribution, keepBuffer: 1 });
    let failed = false; satellite.on('tileerror', () => { if (!failed) { failed = true; notify('Satellite tiles failed. Switch to Street, then check your provider key and usage.'); } });
    if (baseLayer) baseLayer.remove(); baseLayer = satellite.addTo(map);
    imageryKeys[provider] = key; activeImageryProvider = provider;
    map.setMaxZoom(nativeZoom);
    satelliteActive = true; $('street').classList.remove('selected'); $('satellite').classList.add('selected'); $('mapState').textContent = `${esri ? 'Esri World Imagery' : 'MapTiler Satellite'} · imagery is not live`; $('maptilerLogo').hidden = esri;
    $('settingsDialog').close(); notify('Satellite connected. Image age and detail vary by location.');
  } catch (error) { $('keyError').textContent = error.name === 'TimeoutError' ? 'Connection timed out. Check your internet and try again.' : error instanceof TypeError ? 'Could not reach the imagery provider. Check your connection or content blocker, then try again.' : error.message; }
  finally { $('saveKey').disabled = false; $('saveKey').textContent = 'Connect satellite'; }
});
render(); initializeMap();
scheduleRoadRoute();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
