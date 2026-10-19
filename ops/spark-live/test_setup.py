"""Offline synthetic tests. No subprocess bootstrap, network, keys or services."""
import contextlib, copy, importlib.util, io, json, os, pathlib, subprocess, sys, tempfile, unittest
from unittest import mock
BASE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('remote_setup',BASE/'remote_setup.py'); remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
spec=importlib.util.spec_from_file_location('mac_setup',BASE/'setup.py'); mac=importlib.util.module_from_spec(spec);spec.loader.exec_module(mac)
class SetupTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.home=pathlib.Path(self.temp.name).resolve();self.cfg=self.home/'.config/pi-model-runner';self.state=self.home/'.local/state/pi-model-runner'
  for p in (self.cfg,self.state):p.mkdir(parents=True,mode=0o700)
  self.host='urn:uuid:00000000-0000-4000-8000-000000000001';remote.exclusive(self.cfg/'host.json',json.dumps({'hostId':self.host}))
  self.payload={'credential':{'clientId':'synthetic-client','subject':'synthetic-subject','hostId':'urn:uuid:laptop-fixture','access':'SYNTHETIC-ACCESS','refresh':'SYNTHETIC-REFRESH','idToken':'SYNTHETIC-ID','expires':12345,'scopes':sorted(remote.SCOPES)},'hmac':'07'*32,'tunnelToken':'SYNTHETIC-TUNNEL-TOKEN-ONLY'}
 def tearDown(self):self.temp.cleanup()
 def import_payload(self,payload):
  with contextlib.redirect_stdout(io.StringIO()):remote.import_secret(self.home,payload)
 def test_import_preserves_registration_and_scope_but_uses_vm_host(self):
  original=copy.deepcopy(self.payload);self.import_payload(self.payload);c=json.loads((self.cfg/'credentials.json').read_text())
  self.assertEqual(c['hostId'],self.host)
  for key in ('clientId','subject','access','refresh','idToken','expires','scopes'):self.assertEqual(c[key],original['credential'][key])
  self.assertEqual(self.payload,original)
  for name in ('credentials.json','transport-key.hex','tunnel-token','config.json'):self.assertEqual((self.cfg/name).stat().st_mode&0o777,0o600)
  config=json.loads((self.cfg/'config.json').read_text());self.assertEqual(config['port'],4320);self.assertEqual(config['identity']['hostId'],self.host);self.assertNotIn('SYNTHETIC-ACCESS',json.dumps(config))
 def test_duplicate_import_preserves_existing_credential_and_state(self):
  self.import_payload(self.payload);before=(self.cfg/'credentials.json').read_bytes();remote.exclusive(self.state/'rounds.jsonl','retained fence\n')
  with self.assertRaises(ValueError):self.import_payload(self.payload)
  self.assertEqual((self.cfg/'credentials.json').read_bytes(),before);self.assertEqual((self.state/'rounds.jsonl').read_text(),'retained fence\n')
 def test_invalid_payload_cannot_partially_write(self):
  for mutate in [lambda p:p.update(hmac='bad'),lambda p:p.update(tunnelToken='unsafe\nvalue'),lambda p:p['credential'].update(access='sk-proj-fixture'),lambda p:p['credential'].update(clientId='dynamic_agent_client'),lambda p:p['credential'].update(scopes=['openid']),lambda p:p['credential'].update(expires=float('inf'))]:
   payload=copy.deepcopy(self.payload);mutate(payload)
   with self.assertRaises(ValueError):self.import_payload(payload)
   self.assertFalse((self.cfg/'credentials.json').exists())
 def test_protected_paths_and_source_read_refuse_symlinks_and_loose_modes(self):
  self.cfg.chmod(0o755)
  with self.assertRaises(ValueError):self.import_payload(self.payload)
  self.cfg.chmod(0o700);remote.exclusive(self.cfg/'input.json',json.dumps(self.payload['credential']));self.assertEqual(mac.read_credential(self.cfg/'input.json')['clientId'],'synthetic-client')
  (self.cfg/'alias.json').symlink_to(self.cfg/'input.json')
  with self.assertRaises(OSError):mac.read_credential(self.cfg/'alias.json')
  (self.cfg/'input.json').chmod(0o644)
  with self.assertRaises(ValueError):mac.read_credential(self.cfg/'input.json')
 def test_units_never_expose_tokens_and_have_correct_owner_boot_and_stop_policy(self):
  model=remote.unit_text('model',self.home);tunnel=remote.unit_text('tunnel',self.home)
  for unit in (model,tunnel):self.assertIn('User=andrewkurin',unit);self.assertIn('WantedBy=multi-user.target',unit);self.assertIn('UMask=0077',unit);self.assertNotIn('SYNTHETIC',unit)
  self.assertIn('Restart=no',model);self.assertIn('TimeoutStopSec=45',model);self.assertIn('--token-file',tunnel);self.assertNotIn('--token ',tunnel)
 def test_exclusive_write_never_replaces_file_or_symlink(self):
  p=self.cfg/'existing';remote.exclusive(p,'retained')
  with self.assertRaises(FileExistsError):remote.exclusive(p,'new')
  alias=self.cfg/'alias';alias.symlink_to(p)
  with self.assertRaises(FileExistsError):remote.exclusive(alias,'new')
  self.assertEqual(p.read_text(),'retained')
 def test_plan_and_missing_approval_are_inert_and_do_not_prompt(self):
  for file in ('setup.py','remote_setup.py'):
   r=subprocess.run([sys.executable,'-B',str(BASE/file)],capture_output=True,text=True);self.assertEqual(r.returncode,0);self.assertNotIn('SYNTHETIC',r.stdout+r.stderr)
  r=subprocess.run([sys.executable,'-B',str(BASE/'setup.py'),'--execute'],capture_output=True,text=True);self.assertNotEqual(r.returncode,0);self.assertNotIn('token (hidden)',r.stdout+r.stderr)
 def mac_fixture(self):
  local=self.home/'mac';parent=local/'.runtime/local-siwc';parent.mkdir(parents=True,mode=0o700);remote.exclusive(parent/'credentials.json',json.dumps(self.payload['credential']))
  helper=local/'ops/spark-live';helper.mkdir(parents=True);(helper/'remote_setup.py').write_text('synthetic helper only')
  return local,parent
 def run_mac(self,local,callback):
  with mock.patch.object(mac,'ROOT',local),mock.patch.object(mac.sys,'platform','darwin'),mock.patch.object(mac.sys.stdin,'isatty',return_value=True),mock.patch.object(mac.getpass,'getpass',return_value=self.payload['tunnelToken']),mock.patch.object(mac.secrets,'token_hex',return_value=self.payload['hmac']),mock.patch.object(mac,'run',side_effect=callback),contextlib.redirect_stdout(io.StringIO()):mac.execute(False)
 def test_bootstrap_failure_keeps_active_mac_credential_and_never_imports(self):
  local,parent=self.mac_fixture();calls=[]
  def command(args,**kw):calls.append(args);self.assertIn('set -eu;',args[-1]);raise subprocess.CalledProcessError(1,args)
  with self.assertRaises(subprocess.CalledProcessError):self.run_mac(local,command)
  self.assertEqual(len(calls),1);self.assertTrue((parent/'credentials.json').exists());self.assertFalse((parent/'credentials.retired-to-spark.json').exists());self.assertFalse((local/'.runtime/spark-live-activation/transport-key.hex').exists())
 def test_uncertain_import_keeps_mac_locked_and_never_starts_services(self):
  local,parent=self.mac_fixture();calls=[]
  def command(args,**kw):
   calls.append(args)
   if '--import-secret' in args[-1]:raise subprocess.CalledProcessError(1,args)
  with self.assertRaises(subprocess.CalledProcessError):self.run_mac(local,command)
  self.assertEqual(len(calls),2);self.assertTrue((parent/'credentials.json').exists());self.assertTrue((parent/'credentials.json.owner').exists());self.assertFalse((parent/'credentials.retired-to-spark.json').exists());self.assertEqual(json.loads((local/'.runtime/spark-live-activation/phase.json').read_text())['phase'],'import-uncertain')
 def test_ambiguous_refresh_marker_blocks_all_transport(self):
  local,parent=self.mac_fixture();remote.exclusive(parent/'credentials.json.refreshing','unresolved')
  with self.assertRaises(ValueError):self.run_mac(local,lambda *a,**k:self.fail('No transport allowed'))
  self.assertTrue((parent/'credentials.json').exists())
 def test_success_retires_and_syncs_mac_before_enabling_service(self):
  local,parent=self.mac_fixture();calls=[];syncs=[];real_sync=mac.sync_dir
  def command(args,**kw):
   calls.append(args)
   if 'install-services.sh' in args[-1]:
    self.assertFalse((parent/'credentials.json').exists());self.assertTrue((parent/'credentials.retired-to-spark.json').exists());self.assertFalse((parent/'credentials.json.owner').exists());self.assertGreaterEqual(syncs.count(parent),2)
  def sync(path):syncs.append(path);real_sync(path)
  with mock.patch.object(mac,'sync_dir',side_effect=sync):self.run_mac(local,command)
  self.assertEqual(len(calls),3);self.assertEqual(json.loads((local/'.runtime/spark-live-activation/phase.json').read_text())['phase'],'services-enabled')
 def test_bad_remote_runtime_stops_before_creating_live_paths(self):
  with mock.patch.object(remote.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'v18.0.0\n')):
   with self.assertRaises(ValueError):remote.bootstrap(self.home)
  self.assertFalse((self.home/'projects/pi-model-runner-live').exists())
if __name__=='__main__':unittest.main()
