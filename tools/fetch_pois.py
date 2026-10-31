#!/usr/bin/env python3
"""One-time tool: build pois.js (named places in Frederick County, MD) from OpenStreetMap.

Not part of the deployed site. Run from the repo root:
    python3 tools/fetch_pois.py
Makes one Overpass API request and writes pois.js next to index.html.
Standard library only.
"""
import json
import math
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
USER_AGENT = 'DFRSRecommend-poi-builder/1.0 (one-time static data build)'
# A point in downtown Frederick, MD; picks the right county (Frederick County, VA also exists)
ANCHOR = (39.414, -77.410)
TAGS = ['shop', 'amenity', 'tourism', 'office', 'healthcare', 'leisure']
DEDUPE_M = 75  # same name this close together = one place (store node + building outline)
OUT = Path(__file__).resolve().parent.parent / 'pois.js'

# One request: the areas containing the anchor (to confirm county + state), the county
# boundary geometry (for clipping), then every named place with one of TAGS inside it.
QUERY = f"""
[out:json][timeout:300];
is_in({ANCHOR[0]},{ANCHOR[1]})->.here;
area.here["boundary"="administrative"]["admin_level"="4"]->.state;
area.here["boundary"="administrative"]["admin_level"="6"]->.county;
.state out tags;
.county out tags;
rel(pivot.county);
out geom;
(
{''.join(f'  nwr(area.county)["name"]["{t}"];{chr(10)}' for t in TAGS)});
out center tags;
"""


def fetch():
    body = urllib.parse.urlencode({'data': QUERY}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=body, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=360) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code in (429, 504):
            sys.exit(f'Overpass is busy (HTTP {e.code}). Wait a few minutes and run again.')
        sys.exit(f'Overpass error: HTTP {e.code} {e.reason}')
    except urllib.error.URLError as e:
        if 'SSL' not in str(e.reason):
            sys.exit(f'Could not reach Overpass: {e.reason}')
        # Older Python builds can't negotiate TLS with Overpass; the system curl can
        print('Python SSL too old for Overpass; using curl instead.')
        return fetch_with_curl(body)


def fetch_with_curl(body):
    r = subprocess.run(['curl', '-sS', '--max-time', '360', '-A', USER_AGENT, '-w', '\n%{http_code}',
                        '--data-binary', '@-', OVERPASS_URL], input=body, capture_output=True)
    if r.returncode:
        sys.exit(f'Could not reach Overpass: {r.stderr.decode().strip()}')
    text, _, code = r.stdout.decode().rpartition('\n')
    if code in ('429', '504'):
        sys.exit(f'Overpass is busy (HTTP {code}). Wait a few minutes and run again.')
    if code != '200':
        sys.exit(f'Overpass error: HTTP {code}')
    return json.loads(text)


def boundary_segments(rel):
    """All outer/inner way segments of the county relation. Even-odd ray casting over every
    segment works without stitching ways into rings, as long as the boundary is closed."""
    segs = []
    for m in rel.get('members', []):
        if m.get('type') == 'way' and m.get('role') in ('outer', 'inner') and m.get('geometry'):
            pts = [(p['lon'], p['lat']) for p in m['geometry']]
            segs.extend(zip(pts, pts[1:]))
    return segs


def inside(lon, lat, segs):
    hit = False
    for (x1, y1), (x2, y2) in segs:
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def meters(a, b):
    dx = (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0]))
    dy = (b[0] - a[0]) * 110540
    return math.hypot(dx, dy)


def main():
    data = fetch()
    els = data.get('elements', [])
    areas = [e for e in els if e['type'] == 'area']
    state = next((a for a in areas if a['tags'].get('admin_level') == '4'), None)
    county = next((a for a in areas if a['tags'].get('admin_level') == '6'), None)
    rel = next((e for e in els if e['type'] == 'relation' and e.get('tags', {}).get('admin_level') == '6'), None)
    if not (state and county and rel):
        sys.exit('Could not find the county boundary around the anchor point.')
    sname, cname = state['tags'].get('name'), county['tags'].get('name')
    if sname != 'Maryland' or cname != 'Frederick County':
        sys.exit(f'Wrong boundary: got {cname}, {sname}. Expected Frederick County, Maryland.')
    print(f'Boundary: {cname}, {sname} (OSM relation {rel["id"]})')

    segs = boundary_segments(rel)
    if not inside(ANCHOR[1], ANCHOR[0], segs):
        sys.exit('Boundary geometry looks incomplete (anchor point is not inside it).')

    places, dropped = [], 0
    for e in els:
        if e['type'] not in ('node', 'way', 'relation') or e.get('tags', {}).get('admin_level'):
            continue
        t = e.get('tags', {})
        name = t.get('name', '').strip()
        c = e if e['type'] == 'node' else e.get('center')
        if not name or not c:
            continue
        lat, lon = c['lat'], c['lon']
        if not inside(lon, lat, segs):
            dropped += 1
            continue
        cat = next((f'{k}={t[k]}' for k in TAGS if k in t), '')
        street = ' '.join(x for x in (t.get('addr:housenumber', ''), t.get('addr:street', '')) if x)
        places.append([name, t.get('brand', ''), cat, street, t.get('addr:city', ''),
                       round(lat, 5), round(lon, 5)])

    # De-duplicate: same name (case-insensitive) within DEDUPE_M; keep the entry with more filled fields
    places.sort(key=lambda p: (p[0].lower(), -sum(bool(x) for x in p[1:5])))
    kept = []
    for p in places:
        dup = next((k for k in reversed(kept) if k[0].lower() == p[0].lower()
                    and meters((k[5], k[6]), (p[5], p[6])) <= DEDUPE_M), None)
        if dup is None:
            kept.append(p)
        else:  # fill gaps in the kept entry from the duplicate
            for i in range(1, 5):
                dup[i] = dup[i] or p[i]

    lines = ',\n'.join(json.dumps(p, ensure_ascii=False, separators=(',', ':')) for p in kept)
    OUT.write_text('// Data (c) OpenStreetMap contributors, ODbL\n'
                   '// [name, brand, category, address, town, lat, lon]\n'
                   f'window.POIS = [\n{lines}\n];\n', encoding='utf-8')

    print(f'Clipped outside county: {dropped}; duplicates merged: {len(places) - len(kept)}')
    print(f'Wrote {OUT.name}: {len(kept)} places, {OUT.stat().st_size / 1024:.0f} KB')


if __name__ == '__main__':
    main()
