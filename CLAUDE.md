## Hard rules
- **Local-only operation.** No incident, unit, address, or user-action data
  is sent anywhere except the Frederick County public GIS services
  (fcgis.frederickcountymd.gov), which receive map coordinates only
  (basemap tiles and ESZ lookup). No analytics, no third-party geocoders
  (e.g., Nominatim/OpenStreetMap), no third-party APIs.
- **Static dependencies only.** Load libraries (Leaflet, esri-leaflet) from
  local files in the repo, not from a CDN, so the page doesn't depend on
  outside hosts.
- **Typed addresses never leave the browser except to a county-run
  geocoder.** If no county geocoder is available, address search is
  disabled and the user locates by clicking the map.
- (keep the rest of the Hard rules unchanged: no timestamps/logs,
  no persistence, fictional data only, static GitHub Pages)

## Unit status codes
| Code | Meaning |
|------|---------|
| AQ | Available Quarters. The only status treated as available |
| PA | Pending Available (treated as unavailable) |
| CA / CALL | Assumed: unit is committed to an active event, so it is not recommended for another. Not yet confirmed |
| OOS | Out of Service |

## Notes
- Files: index.html (UI), app.js (logic), data.js (all plan and unit data),
  styles.css.
- Data lives in window.DATA in data.js: PLAN_STRUCT, PLAN_NH_OVERRIDES,
  UNIT_CAPS, UNIT_STATUS, STATION_UNITS, ESZ_ORDER, GLOBAL_ORDER,
  NON_HYDRANT_ESZ.
- GIS: Leaflet map with a county basemap; ESZ is found by querying the
  county EmergencyESZ MapServer layer for the clicked or located point.
- Address search uses the county locator
  Geoprocessors/FrederickCountyAddressesPublic/GeocodeServer. It matches
  street addresses only (no intersections or POIs).
- Leaflet 1.9.4 and esri-leaflet 3.1.0 are vendored in vendor/.
- Known open item: two plans require a BUS capability no unit has.