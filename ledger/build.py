import json, subprocess, sys, os, datetime

S = os.path.dirname(os.path.abspath(__file__))


def load(path):
    """Read a ccusage JSON file that may start with a BOM and may be UTF-16."""
    b = open(path, 'rb').read()
    if b[:2] == b'\xff\xfe':
        t = b.decode('utf-16-le')
    elif b[:2] == b'\xfe\xff':
        t = b.decode('utf-16-be')
    elif len(b) > 3 and b[1] == 0 and b[3] == 0:
        t = b.decode('utf-16-le')
    else:
        t = b.decode('utf-8')
    t = t.lstrip('﻿')
    return json.loads(t[min([i for i in (t.find('{'), t.find('[')) if i >= 0]):])


def num(x):
    try:
        return float(x or 0)
    except (TypeError, ValueError):
        return 0.0


daily = load(os.path.join(S, 'daily.json'))
session = load(os.path.join(S, 'session.json'))

# computer name and local IPv4 (Linux stand-ins for $env:COMPUTERNAME and Get-NetIPAddress)
name = subprocess.check_output(['hostname'], text=True).strip().upper() if os.environ.get('UPPER') else subprocess.check_output(['hostname'], text=True).strip()
ip = subprocess.check_output(['hostname', '-I'], text=True).split()[0]
label = f'{name} · {ip}'

# one row per day and model, Claude models only
rows = []
for d in daily.get('daily', []):
    date = (d.get('date') or d.get('period') or '')[:10]
    for b in d.get('modelBreakdowns', []):
        m = b.get('modelName') or b.get('model') or ''
        if not m.startswith('claude-'):
            continue
        rows.append([date, m, int(num(b.get('inputTokens'))), int(num(b.get('outputTokens'))),
                     int(num(b.get('cacheCreationTokens'))), int(num(b.get('cacheReadTokens'))),
                     round(num(b.get('cost', b.get('totalCost'))), 6)])
rows.sort(key=lambda r: (r[0], r[1]))

# ten largest Claude sessions by cost
sess = []
for s in session.get('session', session.get('sessions', [])):
    bds = [b for b in s.get('modelBreakdowns', []) if (b.get('modelName') or '').startswith('claude-')]
    if not bds:
        continue
    inp = sum(int(num(b.get('inputTokens'))) for b in bds)
    out = sum(int(num(b.get('outputTokens'))) for b in bds)
    cw = sum(int(num(b.get('cacheCreationTokens'))) for b in bds)
    cr = sum(int(num(b.get('cacheReadTokens'))) for b in bds)
    cost = sum(num(b.get('cost', b.get('totalCost'))) for b in bds)
    sess.append({
        'pc': label,
        'id': s.get('sessionId') or s.get('period') or '',
        'last': s.get('lastActivity') or (s.get('metadata') or {}).get('lastActivity') or '',
        'models': sorted({b['modelName'] for b in bds}),
        'out': out, 'all': inp + out + cw + cr, 'cost': round(cost, 6),
    })
sess.sort(key=lambda s: -s['cost'])
sess = sess[:10]

def system_string():
    def lines(path):
        try:
            return open(path).read().splitlines()
        except OSError:
            return []
    osr = {}
    for line in lines('/etc/os-release'):
        if '=' in line:
            k, v = line.split('=', 1)
            osr[k] = v.strip().strip('"\'')
    cpu = ''
    for line in lines('/proc/cpuinfo'):
        if line.startswith(('model name', 'Model name')):
            cpu = line.split(':', 1)[1].strip()
            break
    mem = 0.0
    for line in lines('/proc/meminfo'):
        if line.startswith('MemTotal'):
            mem = int(line.split()[1]) / 1048576
            break
    un = os.uname()
    cores = f'{os.cpu_count()} cores'
    parts = [osr.get('PRETTY_NAME') or un.sysname, f'{un.sysname} {un.release} {un.machine}',
             f'{cpu}, {cores}' if cpu else cores, f'{mem:.1f} GB RAM' if mem else '']
    return ' | '.join(x for x in parts if x)


sysinfo = system_string()
seed = {'generated': datetime.date.today().isoformat(), 'pcs': [{'label': label, 'system': sysinfo, 'rows': rows}], 'sessions': sess}
blob = json.dumps(seed, ensure_ascii=True, separators=(',', ':')).replace('</', '<\\/')

tpl = open(os.path.join(S, 'ledger.tpl.html'), encoding='utf-8').read()
assert '/*__SEED__*/null' in tpl
html = tpl.replace('/*__SEED__*/null', blob)
open(os.path.join(S, 'claude-usage-ledger.html'), 'w', encoding='utf-8').write(html)

# extract the page script for a syntax check
a = html.index('<script>') + 8
b = html.rindex('</script>')
open(os.path.join(S, 'page.js'), 'w', encoding='utf-8').write(html[a:b])

print('label  :', label)
print('system :', sysinfo)
print('rows   :', len(rows), rows)
print('sess   :', len(sess), sess)
