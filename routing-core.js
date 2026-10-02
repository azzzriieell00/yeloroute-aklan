/* Road geometry helpers shared by the map and vehicle simulation. */
(() => {
  const radians = value => value * Math.PI / 180;
  function distance(a, b) {
    const lat = radians(b[0] - a[0]), lon = radians(b[1] - a[1]);
    const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a[0])) * Math.cos(radians(b[0])) * Math.sin(lon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function parseRoute(data, count) {
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.code === 'NoRoute' ? 'No connected driving route found. Check the delivery locations.' : data.code === 'NoSegment' ? 'A stop is more than 100 m from a mapped driving road. Use Set accurate location to choose its vehicle entrance.' : 'The routing service could not calculate this run.');
    const route = data.routes[0], coordinates = route.geometry?.coordinates;
    const validPoint = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
    if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(validPoint) || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance < 0 || route.duration < 0 || route.legs?.length !== count - 1 || !route.legs.every(leg => Number.isFinite(leg.distance) && leg.distance >= 0 && Number.isFinite(leg.duration) && leg.duration >= 0) || data.waypoints?.length !== count || !data.waypoints.every(waypoint => validPoint(waypoint.location))) throw new Error('The routing service returned incomplete road geometry.');
    const points = coordinates.map(p => [p[1], p[0]]), cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
    if (data.waypoints.some(point => !Number.isFinite(point.distance) || point.distance > 100)) throw new Error('A stop matched a road more than 100 m away. Correct its vehicle entrance before routing.');
    if (!cumulative.at(-1)) throw new Error('Choose distinct delivery locations to create a driving route.');
    return { points, cumulative, distance: route.distance, duration: route.duration, legs: route.legs, waypoints: data.waypoints };
  }
  function positionAt(route, fraction) {
    const target = Math.min(1, Math.max(0, fraction)) * route.cumulative.at(-1);
    let low = 1, high = route.cumulative.length - 1;
    while (low < high) { const middle = Math.floor((low + high) / 2); if (route.cumulative[middle] < target) low = middle + 1; else high = middle; }
    const previous = route.points[low - 1], next = route.points[low];
    const length = route.cumulative[low] - route.cumulative[low - 1];
    const local = length ? (target - route.cumulative[low - 1]) / length : 0;
    return previous.map((coordinate, axis) => coordinate + (next[axis] - coordinate) * local);
  }
  function routeURL(points) {
    if (points.length < 2 || points.length > 25) throw new Error('This prototype supports up to 24 delivery stops per road route. Split larger runs.');
    return `https://router.project-osrm.org/route/v1/driving/${points.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';')}?overview=full&geometries=geojson&steps=true&generate_hints=false&radiuses=${points.map(() => '100').join(';')}`;
  }
  globalThis.YeloRouting = Object.freeze({ distance, parseRoute, positionAt, routeURL });
})();
