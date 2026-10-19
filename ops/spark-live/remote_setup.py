"""First-install helper, invoked by the approved Mac driver. No inference/auth exchange.
Plan is default. Secret input travels only on SSH stdin; errors never echo input.
"""
import argparse, hashlib, json, math, os, pathlib, re, subprocess, sys, urllib.request, uuid
SOURCE = '6773a901153828682c5cb6e2d635dc3e9aae8e5e'
CF_VERSION = '2026.10.1'
CF_SHA256 = '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46'
SCOPES = set('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'.split())

def exclusive(path, value, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'w') as f: f.write(value); f.flush(); os.fsync(f.fileno())
    except BaseException: raise
    d = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(d)
    finally: os.close(d)

def protected_dir(path):
    st = path.lstat()
    if path.is_symlink() or not path.is_dir() or st.st_uid != os.getuid() or st.st_mode & 0o077 or path.resolve() != path: raise ValueError('directory')

def credential_payload(payload, host):
    if set(payload) != {'credential', 'hmac', 'tunnelToken'}: raise ValueError('payload')
    c = payload['credential']
    if not isinstance(c, dict) or not all(isinstance(c.get(k), str) and c[k] for k in ('clientId','subject','hostId','access','refresh','idToken')): raise ValueError('credential')
    if c['clientId'] == 'dynamic_agent_client' or c['access'].startswith('sk-') or (not isinstance(c.get('expires'), (int,float)) or isinstance(c.get('expires'),bool) or not math.isfinite(c['expires'])) or not isinstance(c.get('scopes'), list) or not SCOPES.issubset(set(c['scopes'])): raise ValueError('credential')
    if not re.fullmatch('[a-f0-9]{64}', payload['hmac']) or not re.fullmatch(r'[A-Za-z0-9_+/=.\-]{20,8192}', payload['tunnelToken']): raise ValueError('transport')
    result = dict(c); result['hostId'] = host
    return result

def unit_text(kind, home):
    cfg = home / '.config/pi-model-runner'; source = home / 'projects/pi-model-runner-live'
    common = '[Unit]\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=andrewkurin\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\n'
    if kind == 'model':
        return common + f'WorkingDirectory={source}\nExecStart=/usr/bin/node --import tsx services/model-runner/live-server.ts {cfg}/config.json\nRestart=no\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n'
    return common + f'ExecStart={home}/.local/bin/cloudflared-pi-runner tunnel run --token-file {cfg}/tunnel-token\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n'

def bootstrap(home):
    cfg = home / '.config/pi-model-runner'; state = home / '.local/state/pi-model-runner'; source = home / 'projects/pi-model-runner-live'; binary = home / '.local/bin/cloudflared-pi-runner'
    result=subprocess.run(['/usr/bin/node','--version'],capture_output=True,text=True,check=True)
    if not re.fullmatch(r'v(?:22|24|26)\.\d+\.\d+\s*',result.stdout): raise ValueError('node-version')
    if not pathlib.Path('/usr/bin/npm').is_file(): raise ValueError('npm-path')
    for p in (cfg,state,source,binary):
        if p.exists() or p.is_symlink(): raise ValueError('existing-live-path')
    # Existing system units are never replaced by this first-install helper.
    for name in ('pi-model-runner-live.service','cloudflared-pi-runner.service'):
        result = subprocess.run(['systemctl','show',name,'--property=LoadState','--value'],capture_output=True,text=True,check=True)
        if result.stdout.strip() != 'not-found': raise ValueError('existing-unit')
    for p in (cfg,state): p.mkdir(parents=True,mode=0o700); protected_dir(p)
    source.parent.mkdir(parents=True,exist_ok=True)
    for command in (['git','clone','--quiet','https://github.com/andrew-kurin/pi-durable-cloudflare-chat.git',str(source)],['git','-C',str(source),'checkout','--quiet','--detach',SOURCE],['/usr/bin/npm','ci','--no-audit','--no-fund']):
        subprocess.run(command,env={**os.environ,'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'},cwd=source if source.exists() else home,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
    binary.parent.mkdir(parents=True,exist_ok=True)
    request = urllib.request.Request(f'https://github.com/cloudflare/cloudflared/releases/download/{CF_VERSION}/cloudflared-linux-arm64')
    with urllib.request.urlopen(request,timeout=60) as response: data = response.read(80*1024*1024+1)
    if len(data)>80*1024*1024 or hashlib.sha256(data).hexdigest()!=CF_SHA256: raise ValueError('binary-checksum')
    fd=os.open(binary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700)
    with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
    host='urn:uuid:'+str(uuid.uuid4()); exclusive(cfg/'host.json',json.dumps({'hostId':host})+'\n')
    exclusive(cfg/'pi-model-runner-live.service',unit_text('model',home))
    exclusive(cfg/'cloudflared-pi-runner.service',unit_text('tunnel',home))
    installer='''#!/usr/bin/env bash
set -euo pipefail
cfg="$HOME/.config/pi-model-runner"
test "$(id -un)" = andrewkurin
test -f "$cfg/credentials.json"
test -f "$cfg/config.json"
for name in pi-model-runner-live.service cloudflared-pi-runner.service; do
  test "$(systemctl show "$name" --property=LoadState --value)" = not-found
  sudo test ! -e "/etc/systemd/system/$name"
done
sudo install -o root -g root -m 0644 "$cfg/pi-model-runner-live.service" /etc/systemd/system/pi-model-runner-live.service
sudo install -o root -g root -m 0644 "$cfg/cloudflared-pi-runner.service" /etc/systemd/system/cloudflared-pi-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-model-runner-live.service cloudflared-pi-runner.service
systemctl is-active --quiet pi-model-runner-live.service cloudflared-pi-runner.service
systemctl is-enabled --quiet pi-model-runner-live.service cloudflared-pi-runner.service
printf 'Live model and dedicated tunnel services enabled; no inference sent.\n'
'''
    exclusive(cfg/'install-services.sh',installer,0o700)
    print('Bootstrap prepared; no services started or credentials imported.')

def import_secret(home, payload):
    cfg=home/'.config/pi-model-runner'; state=home/'.local/state/pi-model-runner'; protected_dir(cfg); protected_dir(state)
    for p in ('credentials.json','transport-key.hex','tunnel-token','config.json'):
        if (cfg/p).exists() or (cfg/p).is_symlink(): raise ValueError('existing-secret')
    host=json.loads((cfg/'host.json').read_text())['hostId']; c=credential_payload(payload,host)
    exclusive(cfg/'credentials.json',json.dumps(c)+'\n'); exclusive(cfg/'transport-key.hex',payload['hmac']+'\n'); exclusive(cfg/'tunnel-token',payload['tunnelToken']+'\n')
    config={'eligibility':'confirmed-for-this-deployment','port':4320,'identity':{k:c[k] for k in ('clientId','subject','hostId')},'credentialPath':str(cfg/'credentials.json'),'transportKeyPath':str(cfg/'transport-key.hex'),'stateDirectory':str(state)}
    exclusive(cfg/'config.json',json.dumps(config)+'\n')
    print('Protected import complete; no services started.')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--bootstrap',action='store_true'); parser.add_argument('--import-secret',action='store_true'); args=parser.parse_args()
    if not args.bootstrap and not args.import_secret: print('Inert helper: explicit approved driver required.'); return
    if args.bootstrap and args.import_secret: raise ValueError('mode')
    if os.uname().machine not in ('aarch64','arm64') or pathlib.Path.home()!=pathlib.Path('/home/andrewkurin'): raise ValueError('host')
    os.umask(0o077)
    if args.bootstrap: bootstrap(pathlib.Path.home())
    else:
        data=sys.stdin.buffer.read(65537)
        if len(data)>65536: raise ValueError('payload-size')
        import_secret(pathlib.Path.home(),json.loads(data))
if __name__=='__main__':
    try: main()
    except Exception: print('Setup stopped; state preserved. No secrets or raw errors printed.',file=sys.stderr); sys.exit(1)
