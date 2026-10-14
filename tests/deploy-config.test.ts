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
  for (const file of ['wrangler.jsonc','wrangler.workspace.jsonc']) writeFileSync(join(cwd,file),readFileSync(resolve(file)));
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
  assert.equal(result.config.define.PI_DEPLOYMENT_MODE,JSON.stringify((flags.ENABLE_MODEL==='true'?'chat':flags.ENABLE_SUBSCRIPTION_LOGIN==='true'?'setup':'off')+':web-false:test-false:origin-pi-private-chat.synthetic.workers.dev'));
  assert.equal(result.mode,0o600); assert.equal(result.config.vars.CREDENTIAL_ENCRYPTION_KEY,undefined);
 }
});
test('production config rejects ambiguous flags and concurrent login/model enablement',()=>{
 for(const flags of [{ENABLE_MODEL:'TRUE'},{ENABLE_SUBSCRIPTION_LOGIN:'1'},{ENABLE_WEB_SEARCH:'1'},{ENABLE_WEB_SEARCH_TEST:'1'},{ENABLE_WEB_SEARCH:'true',ENABLE_WEB_SEARCH_TEST:'true'},{ENABLE_MODEL:'true',ENABLE_SUBSCRIPTION_LOGIN:'true'}]) assert.notEqual(prepare(flags).status,0);
});

test('web enablement defaults off and changes bundle mode without embedding search secret',()=>{const off=prepare({ENABLE_MODEL:'true'}),on=prepare({ENABLE_MODEL:'true',ENABLE_WEB_SEARCH:'true',TAVILY_API_KEY:'synthetic'});assert.equal(off.config.vars.ENABLE_WEB_SEARCH,'false');assert.equal(on.config.vars.ENABLE_WEB_SEARCH,'true');assert.notEqual(off.config.define.PI_DEPLOYMENT_MODE,on.config.define.PI_DEPLOYMENT_MODE);assert.ok(!JSON.stringify(on.config).includes('synthetic\"'));assert.equal(on.config.vars.TAVILY_API_KEY,undefined);});

test('explicit dashboard-managed custom domain preserves exact origin and omits route writes while workers.dev retirement is opt-in',()=>{for(const setting of ['true','false']){const r=prepare({CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://pi-chat.example.com',WORKERS_DEV:setting,ENABLE_MODEL:'true',ENABLE_WEB_SEARCH:'true'});assert.equal(r.status,0,r.error);assert.equal(r.config.routes,undefined);assert.equal(r.config.route,undefined);assert.equal(r.config.vars.APP_ORIGIN,'https://pi-chat.example.com');assert.equal(r.config.workers_dev,setting==='true');assert.equal(r.config.preview_urls,false);assert.match(r.config.define.PI_DEPLOYMENT_MODE,/origin-pi-chat.example.com/);}});
test('custom domain rejects mismatched origins, wildcard/IP/credential/path/port forms and inaccessible retirement',()=>{for(const options of [{WORKERS_DEV:'false'},{WORKERS_DEV:'1'},{CUSTOM_DOMAIN:'*.example.com',APP_ORIGIN:'https://pi-chat.example.com'},{CUSTOM_DOMAIN:'127.0.0.1',APP_ORIGIN:'https://127.0.0.1'},{CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://other.example.com'},{CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://user:pass@pi-chat.example.com'},{CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://pi-chat.example.com/path'},{CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://pi-chat.example.com:444'}])assert.notEqual(prepare(options).status,0);});

const workspaceSettings={PROVISION_WORKSPACE:'true',WORKSPACE_REPOSITORY:'owner/trusted-project',WORKSPACE_IMAGE_REFERENCE:'registry.cloudflare.com/'+ 'a'.repeat(32) +'/pi-workspace@sha256:'+ 'c'.repeat(64)};
test('workspace provisioning is explicit, preserves Assistant storage, and activation remains separate',()=>{
 const original=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
 const off=prepare({});assert.equal(off.config.vars.ENABLE_WORKSPACE,'false');assert.deepEqual(off.config.migrations,original.migrations);assert.deepEqual(off.config.durable_objects,original.durable_objects);assert.equal(off.config.containers,undefined);
 const provisioned=prepare(workspaceSettings),active=prepare({...workspaceSettings,ENABLE_WORKSPACE:'true'});
 for(const result of [provisioned,active]){
  assert.equal(result.status,0,result.error);assert.deepEqual(result.config.migrations[0],original.migrations[0]);assert.deepEqual(result.config.durable_objects.bindings[0],original.durable_objects.bindings[0]);
  assert.deepEqual(result.config.migrations[1],{tag:'workspace-v1',new_sqlite_classes:['TaskWorkspace']});assert.equal(result.config.containers[0].scheduling_policy,'durable_object');assert.deepEqual(result.config.containers[0].images,{workspace:{image:workspaceSettings.WORKSPACE_IMAGE_REFERENCE}});assert.equal(result.config.vars.WORKSPACE_IMAGE,'workspace');assert.equal(result.config.routes,undefined);assert.equal(result.config.preview_urls,false);
 }
 assert.equal(provisioned.config.vars.ENABLE_WORKSPACE,'false');assert.equal(active.config.vars.ENABLE_WORKSPACE,'true');assert.notEqual(provisioned.config.define.PI_DEPLOYMENT_MODE,active.config.define.PI_DEPLOYMENT_MODE);
 const updated=prepare({...workspaceSettings,WORKSPACE_IMAGE_REFERENCE:workspaceSettings.WORKSPACE_IMAGE_REFERENCE.replace(/c{64}$/,'d'.repeat(64))});assert.notEqual(updated.config.define.PI_DEPLOYMENT_MODE,provisioned.config.define.PI_DEPLOYMENT_MODE);
});
test('workspace provisioning rejects ambiguous flags, foreign/tag-only images and arbitrary repository URLs',()=>{
 for(const flags of [{ENABLE_WORKSPACE:'true'},{PROVISION_WORKSPACE:'1'},{...workspaceSettings,ENABLE_WORKSPACE:'TRUE'},{...workspaceSettings,WORKSPACE_REPOSITORY:'https://github.com/owner/repo'},{...workspaceSettings,WORKSPACE_REPOSITORY:'../repo'},{...workspaceSettings,WORKSPACE_REPOSITORY:''},{...workspaceSettings,WORKSPACE_IMAGE_REFERENCE:''},{...workspaceSettings,WORKSPACE_IMAGE_REFERENCE:'node:24'},{...workspaceSettings,WORKSPACE_IMAGE_REFERENCE:workspaceSettings.WORKSPACE_IMAGE_REFERENCE.replace('a'.repeat(32),'b'.repeat(32))},{...workspaceSettings,WORKSPACE_IMAGE_REFERENCE:workspaceSettings.WORKSPACE_IMAGE_REFERENCE.replace(/@sha256:.+/,':latest')}])assert.notEqual(prepare(flags).status,0);
});
test('staging is a fresh Worker target, forces provider calls off, and rejects production origins',()=>{
 const flags={...workspaceSettings,DEPLOY_TARGET:'staging',APP_ORIGIN:'https://pi-private-chat-workspace-staging.synthetic.workers.dev',ENABLE_WORKSPACE:'true',ENABLE_MODEL:'true',ENABLE_SUBSCRIPTION_LOGIN:'true',ENABLE_WEB_SEARCH:'true',ENABLE_WEB_SEARCH_TEST:'true'};
 const result=prepare(flags);assert.equal(result.status,0,result.error);assert.equal(result.config.name,'pi-private-chat-workspace-staging');
 assert.equal(result.config.main,'src/workspace-smoke.ts');assert.equal(result.config.assets,undefined);assert.deepEqual(result.config.durable_objects.bindings,[{name:'Workspaces',class_name:'TaskWorkspace'}]);assert.deepEqual(result.config.migrations,[{tag:'workspace-smoke-v1',new_sqlite_classes:['TaskWorkspace']}]);
 for(const flag of ['ENABLE_MODEL','ENABLE_SUBSCRIPTION_LOGIN','ENABLE_WEB_SEARCH','ENABLE_WEB_SEARCH_TEST'])assert.equal(result.config.vars[flag],'false');
 assert.deepEqual(JSON.parse(result.config.vars.WORKSPACE_LIMITS),{taskMs:720000,commandMs:600000,idleMs:60000,warningMs:60000});assert.equal(result.config.vars.CREDENTIAL_ENCRYPTION_KEY,undefined);assert.equal(result.config.vars.TAVILY_API_KEY,undefined);assert.equal(result.config.routes,undefined);
 for(const options of [{DEPLOY_TARGET:'other'},{DEPLOY_TARGET:'staging'},{...flags,CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://pi-chat.example.com'}])assert.notEqual(prepare(options).status,0);
});
test('manual workflow selects reviewed environments and gates image upload in the environment deployment job',()=>{
 const workflow=readFileSync('.github/workflows/deploy.yml','utf8');
 assert.match(workflow,/environment: \$\{\{ inputs.target \|\| 'production' \}\}/);assert.match(workflow,/DEPLOY_TARGET: \$\{\{ inputs.target \|\| 'production' \}\}/);
 for(const setting of ['PROVISION_WORKSPACE','ENABLE_WORKSPACE','WORKSPACE_REPOSITORY','ENABLE_WORKSPACE_SMOKE'])assert.ok(workflow.includes(`${setting}: \${{ vars.${setting} }}`));
 assert.ok(workflow.includes('WORKSPACE_IMAGE_REFERENCE: ${{ env.WORKSPACE_IMAGE_REFERENCE || vars.WORKSPACE_IMAGE_REFERENCE }}'));
 assert.ok(workflow.indexOf('Build and upload approved workspace image')>workflow.indexOf('environment:'));assert.match(workflow,/if: inputs.build_workspace_image/);assert.match(workflow,/--platform linux\/amd64/);assert.match(workflow,/RepoDigests/);
 assert.ok(!workflow.includes('CREDENTIAL_ENCRYPTION_KEY'));assert.ok(!workflow.includes('secret list'));
});
test('production smoke preserves provider/origin settings while ordinary workspace tools stay off',()=>{
 const flags={...workspaceSettings,ENABLE_WORKSPACE_SMOKE:'true',ENABLE_MODEL:'true',ENABLE_WEB_SEARCH:'true',CUSTOM_DOMAIN:'pi-chat.example.com',APP_ORIGIN:'https://pi-chat.example.com',WORKERS_DEV:'false'};
 const r=prepare(flags);assert.equal(r.status,0,r.error);assert.equal(r.config.main,'src/index.ts');assert.equal(r.config.vars.ENABLE_WORKSPACE,'false');assert.equal(r.config.vars.ENABLE_WORKSPACE_SMOKE,'true');assert.equal(r.config.vars.ENABLE_MODEL,'true');assert.equal(r.config.vars.ENABLE_WEB_SEARCH,'true');assert.equal(r.config.vars.APP_ORIGIN,flags.APP_ORIGIN);assert.equal(r.config.workers_dev,false);assert.equal(r.config.routes,undefined);assert.equal(JSON.parse(r.config.vars.WORKSPACE_LIMITS).taskMs,720000);
 assert.notEqual(prepare({...flags,ENABLE_WORKSPACE:'true'}).status,0);assert.notEqual(prepare({ENABLE_WORKSPACE_SMOKE:'true'}).status,0);
 const enabled=prepare({...flags,ENABLE_WORKSPACE:'true',ENABLE_WORKSPACE_SMOKE:'false'});assert.equal(enabled.status,0,enabled.error);assert.equal(enabled.config.vars.WORKSPACE_LIMITS,undefined);assert.notEqual(enabled.config.define.PI_DEPLOYMENT_MODE,r.config.define.PI_DEPLOYMENT_MODE);
});

test('production deployments preserve owner-enabled retained invocation logs while traces/issues remain off',()=>{
 for(const flags of [{},{...workspaceSettings,ENABLE_WORKSPACE:'true',ENABLE_WORKSPACE_SMOKE:'false'}]){const r=prepare(flags);assert.equal(r.status,0,r.error);assert.deepEqual(r.config.observability.logs,{enabled:true,head_sampling_rate:1,invocation_logs:true,persist:true});assert.deepEqual(r.config.observability.traces,{enabled:false,head_sampling_rate:1,persist:true});assert.deepEqual(r.config.observability.issues,{enabled:false});assert.equal(r.config.observability.issue_detection,undefined);}
 const staging=prepare({...workspaceSettings,DEPLOY_TARGET:'staging',APP_ORIGIN:'https://pi-private-chat-workspace-staging.synthetic.workers.dev',ENABLE_WORKSPACE:'true'});assert.deepEqual(staging.config.observability,{enabled:false});
});
test('Grok is a separate opt-in and staging keeps all subscription setup off',()=>{
 assert.equal(prepare({}).config.vars.ENABLE_GROK_SUBSCRIPTION,'false');assert.equal(prepare({ENABLE_GROK_SUBSCRIPTION:'true'}).config.vars.ENABLE_GROK_SUBSCRIPTION,'true');assert.notEqual(prepare({}).config.define.PI_DEPLOYMENT_MODE,prepare({ENABLE_GROK_SUBSCRIPTION:'true'}).config.define.PI_DEPLOYMENT_MODE);
 const staging=prepare({...workspaceSettings,DEPLOY_TARGET:'staging',APP_ORIGIN:'https://pi-private-chat-workspace-staging.synthetic.workers.dev',ENABLE_WORKSPACE:'true',ENABLE_GROK_SUBSCRIPTION:'true'});assert.equal(staging.status,0,staging.error);assert.equal(staging.config.vars.ENABLE_GROK_SUBSCRIPTION,'false');
});
