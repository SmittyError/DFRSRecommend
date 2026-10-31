# Frederick County Fire & EMS Dispatch
### CAD Downtime Run-Card Assistant

A browser tool for recommending Fire/EMS units when the CAD system is
unavailable. Enter a location and an incident type, and it recommends
units from run-card rules, station order, and each unit's capabilities.

> **For CAD downtime only. Not a CAD replacement.** This is a work in
> progress. Verify every recommendation against current run cards and
> policy. Unit and run-card data in this version are for testing.

## Features
- **Location search:** street addresses (with a town picker when an
  address exists in several towns), intersections, and ~2,400 named
  places such as businesses, schools, and parks. Or click the map.
- **Automatic ESZ lookup** from the county's public GIS.
- **Run-card recommendations** using station order, unit capabilities,
  non-hydrant overrides, and mutual-aid settings.
- **Unit status:** AQ, PA, CALL, and OOS. Units on a call aren't
  recommended again until cleared.
- **Active incidents:** numbered map pins, plus clearing units back to
  available.
- Light and dark themes, keyboard-friendly.

## Privacy
Runs entirely in your browser. Incidents and unit status live in memory
only and are lost on reload. No timestamps, logs, analytics, cookies, or
storage. Only map coordinates and searched addresses are sent, and only
to Frederick County GIS (fcgis.frederickcountymd.gov).

## Run it
Static site: plain HTML, CSS, and JavaScript, with no build step.

    python3 -m http.server 8000
    # open http://localhost:8000

## Data
- `data.js`: plans, units, stations, and ESZ order.
- `pois.js`: place names built once from OpenStreetMap by
  `tools/fetch_pois.py`. The site never contacts OpenStreetMap at runtime.
- Place data (c) OpenStreetMap contributors, ODbL.

## Credits
Developed by Austin Smith and Dalen Hahn.