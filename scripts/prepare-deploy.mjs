import { readFile, writeFile } from 'node:fs/promises';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing production setting: ${name}`);
  return value;
}

function flag(name) {
  const value = process.env[name]?.trim() || 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid production flag: ${name}`);
  return value;
}
const target = process.env.DEPLOY_TARGET?.trim() || 'production';
if (!['production','staging'].includes(target)) throw new Error('Invalid deployment target');
const workerName = target === 'staging' ? 'pi-private-chat-workspace-staging' : 'pi-private-chat';
const modelEnabled = target === 'staging' ? 'false' : flag('ENABLE_MODEL');
const loginEnabled = target === 'staging' ? 'false' : flag('ENABLE_SUBSCRIPTION_LOGIN');
const webSearchEnabled = target === 'staging' ? 'false' : flag('ENABLE_WEB_SEARCH');
const webSearchTest = target === 'staging' ? 'false' : flag('ENABLE_WEB_SEARCH_TEST');
const workspaceProvisioned = flag('PROVISION_WORKSPACE');
const workspaceEnabled = flag('ENABLE_WORKSPACE');
if (workspaceEnabled === 'true' && workspaceProvisioned !== 'true') throw new Error('Workspace activation requires explicit provisioning');
const repository = process.env.WORKSPACE_REPOSITORY?.trim() || '';
const image = process.env.WORKSPACE_IMAGE_REFERENCE?.trim() || '';
if (webSearchEnabled === 'true' && webSearchTest === 'true') throw new Error('Disable search test mode before enabling normal web search');
if (modelEnabled === 'true' && loginEnabled === 'true') throw new Error('Disable subscription setup before enabling model use');

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Invalid account ID');
const teamDomain = required('ACCESS_TEAM_DOMAIN');
const origin = required('APP_ORIGIN');
const aud = required('ACCESS_AUD');
const owners = required('OWNER_EMAILS').split(',').map(email => email.trim().toLowerCase());
const team = new URL(teamDomain);
const app = new URL(origin);
if (app.port || app.username || app.password || app.search || app.hash || app.pathname !== '/') throw new Error('APP_ORIGIN must be an HTTPS origin without credentials, port, path or query');
if (team.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team.hostname) || team.origin !== teamDomain) {
  throw new Error('ACCESS_TEAM_DOMAIN must be the exact HTTPS team origin');
}
const customDomain = process.env.CUSTOM_DOMAIN?.trim() || '';
const workersDev = process.env.WORKERS_DEV?.trim() || 'true';
if (!['true','false'].includes(workersDev)) throw new Error('Invalid production flag: WORKERS_DEV');
if (customDomain) {
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(customDomain) || app.hostname !== customDomain || app.origin !== origin || app.protocol !== 'https:') throw new Error('CUSTOM_DOMAIN must match the exact HTTPS APP_ORIGIN hostname');
} else if (app.protocol !== 'https:' || !new RegExp(`^${workerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(app.hostname) || app.origin !== origin) {
  throw new Error('APP_ORIGIN must match the selected Worker workers.dev HTTPS origin unless CUSTOM_DOMAIN is configured');
}
if (target === 'staging' && customDomain) throw new Error('Staging uses its separate workers.dev hostname; production custom-domain routing is not supported');
if (!customDomain && workersDev === 'false') throw new Error('A custom domain is required before disabling workers.dev');
if (!/^[a-f0-9]{64}$/i.test(aud)) throw new Error('Invalid Access application audience');
if (owners.length > 10 || owners.some(email => !/^[^\s@,*]+@[^\s@,*]+\.[^\s@,*]+$/.test(email))) throw new Error('Invalid owner email allowlist');
const config = JSON.parse(await readFile(workspaceProvisioned === 'true' ? 'wrangler.workspace.jsonc' : 'wrangler.jsonc', 'utf8'));
if (config.name !== 'pi-private-chat') throw new Error('Unexpected Worker name');
config.name = workerName;
if (target === 'staging') {
  // Shell-only harness: never instantiate Assistant or copy provider/storage credentials.
  config.main = 'src/workspace-smoke.ts';
  delete config.assets;
  config.durable_objects = { bindings: workspaceProvisioned === 'true' ? [{ name: 'Workspaces', class_name: 'TaskWorkspace' }] : [] };
  config.migrations = workspaceProvisioned === 'true' ? [{ tag: 'workspace-smoke-v1', new_sqlite_classes: ['TaskWorkspace'] }] : [];
}
if (workspaceProvisioned === 'true') {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.split('/').some(x => x === '.' || x === '..')) throw new Error('Workspace requires one trusted public owner/repository');
  const prefix = `registry.cloudflare.com/${accountId}/`;
  if (!image.startsWith(prefix) || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/.test(image.slice(prefix.length))) throw new Error('Workspace requires an account-scoped digest-pinned Cloudflare registry image');
  const entry = config.containers?.find(entry => entry.class_name === 'TaskWorkspace');
  if (!entry || entry.scheduling_policy !== 'durable_object' || !config.durable_objects?.bindings?.some(binding => binding.name === 'Workspaces' && binding.class_name === 'TaskWorkspace') || !config.migrations?.some(migration => migration.tag === (target === 'staging' ? 'workspace-smoke-v1' : 'workspace-v1') && migration.new_sqlite_classes?.includes('TaskWorkspace'))) throw new Error('Workspace template bindings/migration are missing');
  entry.images = { workspace: { image } };
}
config.account_id = accountId;
config.workers_dev = workersDev === 'true';
// Routing is managed in the dashboard. Omission prevents Wrangler domain/route writes.
delete config.routes;
delete config.route;
config.preview_urls = false;
config.observability = { enabled: false };
// A bundle change restarts live Durable Objects when feature bindings change.
const mode = modelEnabled === 'true' ? 'chat' : loginEnabled === 'true' ? 'setup' : 'off';
config.define = { ...(config.define || {}), PI_DEPLOYMENT_MODE: JSON.stringify(`${mode}:web-${webSearchEnabled}:test-${webSearchTest}:origin-${app.hostname}`) };
if (workspaceProvisioned === 'true') config.define.PI_DEPLOYMENT_MODE = JSON.stringify(`${mode}:web-${webSearchEnabled}:test-${webSearchTest}:origin-${app.hostname}:workspace-${workspaceEnabled}:${image}:${repository}`);
config.vars = {
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD: aud,
  OWNER_EMAILS: [...new Set(owners)].join(','),
  APP_ORIGIN: origin,
  ENABLE_MODEL: modelEnabled,
  ENABLE_SUBSCRIPTION_LOGIN: loginEnabled,
  ENABLE_WEB_SEARCH: webSearchEnabled,
  ENABLE_WEB_SEARCH_TEST: webSearchTest,
  ENABLE_WORKSPACE: workspaceEnabled,
};
if (workspaceProvisioned === 'true') Object.assign(config.vars, { WORKSPACE_REPOSITORY: repository, WORKSPACE_IMAGE: 'workspace' });
// Leave cancellation/export margin within the separately approved 15-minute smoke window.
if (target === 'staging') config.vars.WORKSPACE_LIMITS = JSON.stringify({ taskMs: 12 * 60000, commandMs: 10 * 60000, idleMs: 60000, warningMs: 60000 });
await writeFile('.deploy.wrangler.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(`Prepared ${target} configuration: model=${modelEnabled}, subscriptionLogin=${loginEnabled}, workspaceProvisioned=${workspaceProvisioned}, workspaceEnabled=${workspaceEnabled}.`);
