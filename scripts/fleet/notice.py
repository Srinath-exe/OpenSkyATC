#!/usr/bin/env python3
"""Write public/models/fleet/{LICENSE,NOTICE.txt}: the GPL text and every model's authors, source and changes.
    python3 scripts/fleet/notice.py public/models/fleet <fgdata commit>"""
import json, shutil, sys
from pathlib import Path
out, commit = Path(sys.argv[1]), sys.argv[2]
idx = json.loads((out / 'index.json').read_text())
shutil.copy('/usr/share/common-licenses/GPL-2', out / 'LICENSE')
lines = [
    'OpenATC textured fleet: aircraft models and liveries from FlightGear',
    '',
    'These models and textures come from the FlightGear flight simulator\'s AI aircraft (fgdata, AI/Aircraft) and are',
    'licensed under the GNU General Public License version 2 (see LICENSE). They are not covered by the MIT licence of',
    'the rest of OpenATC. Original authors and aircraft manufacturers do not endorse OpenATC; airline marks remain',
    'the property of their owners.',
    '',
    f'Source: https://gitlab.com/flightgear/fgdata (branch next, commit {commit}), folder AI/Aircraft.',
    'Changes: converted from AC3D to glTF binary by scripts/fleet/convert_fg.py (geometry flattened, vertices welded,',
    'normals computed, shadow objects removed, gear kept as its own node); textures re-encoded as WebP at no more than',
    '1024 px. The conversion script is part of this repository; the original files are at the source above.',
    '',
    'Models and authors:',
]
for k, m in sorted(idx['models'].items()):
    lines.append(f'  {k}: {m.get("description") or k}' + (f' by {m["authors"]}' if m.get('authors') else '') + f' ({len(m["liveries"])} liveries)')
lines += ['', 'Authors not named above are the FlightGear contributors credited in the fgdata repository history.']
(out / 'NOTICE.txt').write_text('\n'.join(lines) + '\n')
print('notice:', len(idx['models']), 'models')
