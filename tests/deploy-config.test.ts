import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = resolve('scripts/prepare-deploy.mjs');
function prepare(flags: Record<string,string>) {
 const cwd = mkdtempSync(join(tmpdir(),'pi-config-'));
 try {
  writeFileSync(join(cwd,'wrangler.jsonc'),JSON.stringify({name:'pi-private-chat'}));
  const result = spawnSync(process.execPath,[script],{cwd,encoding:'utf8',env:{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),ACCESS_TEAM_DOMAIN:'https://synthetic.cloudflareaccess.com',APP_ORIGIN:'https://pi-private-chat.synthetic.workers.dev',ACCESS_AUD:'b'.repeat(64),OWNER_EMAILS:'owner@example.test',...flags}});
  const config = result.status===0 ? JSON.parse(readFileSync(join(cwd,'.deploy.wrangler.json'),'utf8')) : undefined;
  const mode = result.status===0 ? statSync(join(cwd,'.deploy.wrangler.json')).mode & 0o777 : undefined;
  return {status:result.status,config,mode,error:result.stderr};
 } finally { rmSync(cwd,{recursive:true,force:true}); }
}
test('production modes default off and permit separately approved login or model use',()=>{
 for(const flags of [{},{ENABLE_SUBSCRIPTION_LOGIN:'true'},{ENABLE_MODEL:'true'}]) {
  const result=prepare(flags); assert.equal(result.status,0,result.error);
  assert.equal(result.config.vars.ENABLE_MODEL,flags.ENABLE_MODEL??'false');
  assert.equal(result.config.vars.ENABLE_SUBSCRIPTION_LOGIN,flags.ENABLE_SUBSCRIPTION_LOGIN??'false');
  assert.equal(result.config.define.PI_DEPLOYMENT_MODE,JSON.stringify(flags.ENABLE_MODEL==='true'?'chat':flags.ENABLE_SUBSCRIPTION_LOGIN==='true'?'setup':'off'));
  assert.equal(result.mode,0o600); assert.equal(result.config.vars.CREDENTIAL_ENCRYPTION_KEY,undefined);
 }
});
test('production config rejects ambiguous flags and concurrent login/model enablement',()=>{
 for(const flags of [{ENABLE_MODEL:'TRUE'},{ENABLE_SUBSCRIPTION_LOGIN:'1'},{ENABLE_MODEL:'true',ENABLE_SUBSCRIPTION_LOGIN:'true'}]) assert.notEqual(prepare(flags).status,0);
});
