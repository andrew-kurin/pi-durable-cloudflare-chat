"""Mac user-run first-install flow. Default plan is inert. Never sends inference.
The --execute gate is for explicit human approval, not a substitute for it.
"""
import argparse, getpass, json, os, pathlib, secrets, stat, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
SSH=['ssh','-i',str(pathlib.Path.home()/'.ssh/ghost_ed25519'),'-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','BatchMode=yes','-o','ConnectTimeout=8']
HOST='dgx'
def run(args, **kw): return subprocess.run(args,check=True,**kw)
def read_credential(path):
    st=path.parent.lstat()
    if path.parent.is_symlink() or path.parent.resolve()!=path.parent or st.st_mode&0o077 or st.st_uid!=os.getuid(): raise ValueError('credential-directory')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        st=os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_mode&0o077 or st.st_uid!=os.getuid() or st.st_size>32768 or st.st_nlink!=1: raise ValueError('credential-file')
        return json.load(f)
def exclusive(path,text):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f: f.write(text);f.flush();os.fsync(f.fileno())
def sync_dir(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
def execute(copy_key):
    if sys.platform!='darwin' or not sys.stdin.isatty(): raise ValueError('interactive-mac-required')
    credential_path=ROOT/'.runtime/local-siwc/credentials.json'; retired=credential_path.with_name('credentials.retired-to-spark.json')
    state=ROOT/'.runtime/spark-live-activation'; state.mkdir(mode=0o700)
    if state.resolve()!=state: raise ValueError('protected-state-path')
    def phase(value):
        temp=state/'phase.tmp';exclusive(temp,json.dumps({'phase':value})+'\n');os.rename(temp,state/'phase.json');sync_dir(state)
    phase('started')
    if retired.exists() or retired.is_symlink(): raise ValueError('retired-file-exists')
    # The same owner lock used by the application blocks concurrent renewal.
    lock=credential_path.with_name('credentials.json.owner')
    exclusive(lock,'Spark handoff in progress; resolve manually after uncertain transfer.\n')
    phase('mac-owner-locked')
    if os.path.lexists(str(credential_path)+'.refreshing'): raise ValueError('ambiguous-refresh-marker')
    credential=read_credential(credential_path)
    token=getpass.getpass('Dedicated pi-model-runner-spark tunnel token (hidden): ')
    if not token: raise ValueError('empty-tunnel-token')
    # Bootstrap has no secret input. A unique cached helper is never overwritten.
    helper=(ROOT/'ops/spark-live/remote_setup.py').read_bytes()
    bootstrap="set -eu; umask 077; test ! -e /home/andrewkurin/.cache/pi-model-runner-setup.py; mkdir -p /home/andrewkurin/.cache; set -C; cat > /home/andrewkurin/.cache/pi-model-runner-setup.py; chmod 700 /home/andrewkurin/.cache/pi-model-runner-setup.py; python3 /home/andrewkurin/.cache/pi-model-runner-setup.py --bootstrap"
    phase('bootstrap-started')
    run(SSH+[HOST,bootstrap],input=helper,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    phase('bootstrap-complete')
    key=secrets.token_hex(32); exclusive(state/'transport-key.hex',key+'\n')
    payload=json.dumps({'credential':credential,'hmac':key,'tunnelToken':token}).encode()
    phase('import-uncertain')
    run(SSH+[HOST,'python3 /home/andrewkurin/.cache/pi-model-runner-setup.py --import-secret'],input=payload,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    # Retire active Mac registration before starting Spark's sole refresh owner.
    # Keep a protected, explicitly retired recovery record; never auto-reuse it.
    phase('import-acknowledged')
    os.rename(credential_path,retired); sync_dir(credential_path.parent); phase('mac-retired'); lock.unlink(); sync_dir(credential_path.parent); exclusive(state/'handoff-complete','Active Mac credential retired; Spark owns later refreshes.\n')
    credential=None; payload=None; token=None
    run(SSH+['-t',HOST,'bash /home/andrewkurin/.config/pi-model-runner/install-services.sh'])
    phase('services-enabled')
    if copy_key:
        run(['pbcopy'],input=key.encode()); print('Transport key copied to clipboard for Worker secret entry. Clear clipboard after pasting.')
    print('Set Worker secret MODEL_RUNNER_TRANSPORT_KEY in its existing dashboard, then leave runner flags OFF until the separately approved rollout. No model requests sent.')
    print('Protected key handoff file: '+str(state/'transport-key.hex'))
def main():
    p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');p.add_argument('--approved-access-and-services',action='store_true');p.add_argument('--eligibility-reviewed',action='store_true');p.add_argument('--copy-worker-key',action='store_true');a=p.parse_args()
    if not a.execute:
        print('PLAN ONLY: dedicated pi-model-runner-spark Tunnel; pi-runner.andrewkurin.com ->127.0.0.1:4320; protected same-session SSH handoff; active Mac credential retirement; two boot-enabled system units. No provider calls, Worker changes, DNS writes or credentials created.');return
    if not a.approved_access_and_services or not a.eligibility_reviewed: raise ValueError('explicit-approval-required')
    os.umask(0o077);execute(a.copy_worker_key)
if __name__=='__main__':
    try:main()
    except Exception:print('Setup stopped; protected state preserved. Do not rerun after an uncertain handoff; inspect phase before resuming. No secret values printed.',file=sys.stderr);sys.exit(1)
