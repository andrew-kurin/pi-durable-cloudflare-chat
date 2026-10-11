import { readFile, writeFile } from 'node:fs/promises';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing production setting: ${name}`);
  return value;
}

const accountId = required('CLOUDFLARE_ACCOUNT_ID');
if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('Invalid account ID');
const teamDomain = required('ACCESS_TEAM_DOMAIN');
const origin = required('APP_ORIGIN');
const aud = required('ACCESS_AUD');
const owners = required('OWNER_EMAILS').split(',').map(email => email.trim().toLowerCase());
const team = new URL(teamDomain);
const app = new URL(origin);
if (team.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team.hostname) || team.origin !== teamDomain) {
  throw new Error('ACCESS_TEAM_DOMAIN must be the exact HTTPS team origin');
}
// Initial pipeline supports only the existing Worker name on workers.dev.
// Custom domains need a separately reviewed route and permission change.
if (app.protocol !== 'https:' || !/^pi-private-chat\.[a-z0-9-]+\.workers\.dev$/.test(app.hostname) || app.origin !== origin) {
  throw new Error('APP_ORIGIN must be the exact pi-private-chat workers.dev HTTPS origin');
}
if (!/^[a-f0-9]{64}$/i.test(aud)) throw new Error('Invalid Access application audience');
if (owners.length > 10 || owners.some(email => !/^[^\s@,*]+@[^\s@,*]+\.[^\s@,*]+$/.test(email))) throw new Error('Invalid owner email allowlist');
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.name !== 'pi-private-chat') throw new Error('Unexpected Worker name');
config.account_id = accountId;
config.workers_dev = true;
config.preview_urls = false;
config.observability = { enabled: false };
config.vars = {
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD: aud,
  OWNER_EMAILS: [...new Set(owners)].join(','),
  APP_ORIGIN: origin,
  ENABLE_MODEL: 'false',
  ENABLE_SUBSCRIPTION_LOGIN: 'false',
};
await writeFile('.deploy.wrangler.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log('Prepared production configuration with model and subscription login disabled.');
