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
const modelEnabled = flag('ENABLE_MODEL');
const loginEnabled = flag('ENABLE_SUBSCRIPTION_LOGIN');
const webSearchEnabled = flag('ENABLE_WEB_SEARCH');
const webSearchTest = flag('ENABLE_WEB_SEARCH_TEST');
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
} else if (app.protocol !== 'https:' || !/^pi-private-chat\.[a-z0-9-]+\.workers\.dev$/.test(app.hostname) || app.origin !== origin) {
  throw new Error('APP_ORIGIN must be the exact pi-private-chat workers.dev HTTPS origin unless CUSTOM_DOMAIN is configured');
}
if (!customDomain && workersDev === 'false') throw new Error('A custom domain is required before disabling workers.dev');
if (!/^[a-f0-9]{64}$/i.test(aud)) throw new Error('Invalid Access application audience');
if (owners.length > 10 || owners.some(email => !/^[^\s@,*]+@[^\s@,*]+\.[^\s@,*]+$/.test(email))) throw new Error('Invalid owner email allowlist');
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.name !== 'pi-private-chat') throw new Error('Unexpected Worker name');
config.account_id = accountId;
config.workers_dev = workersDev === 'true';
config.routes = customDomain ? [{pattern:customDomain,custom_domain:true}] : [];
config.preview_urls = false;
config.observability = { enabled: false };
// A bundle change restarts live Durable Objects when feature bindings change.
const mode = modelEnabled === 'true' ? 'chat' : loginEnabled === 'true' ? 'setup' : 'off';
config.define = { ...(config.define || {}), PI_DEPLOYMENT_MODE: JSON.stringify(`${mode}:web-${webSearchEnabled}:test-${webSearchTest}:origin-${app.hostname}`) };
config.vars = {
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD: aud,
  OWNER_EMAILS: [...new Set(owners)].join(','),
  APP_ORIGIN: origin,
  ENABLE_MODEL: modelEnabled,
  ENABLE_SUBSCRIPTION_LOGIN: loginEnabled,
  ENABLE_WEB_SEARCH: webSearchEnabled,
  ENABLE_WEB_SEARCH_TEST: webSearchTest,
};
await writeFile('.deploy.wrangler.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(`Prepared production configuration: model=${modelEnabled}, subscriptionLogin=${loginEnabled}.`);
