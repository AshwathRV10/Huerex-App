/**
 * Proves the permission model is enforced on the server, not merely hidden in
 * the UI: a production user holding a valid session cookie is refused the
 * costing API outright, and a store user who may see fabric gets rows with the
 * rate columns physically absent from the JSON.
 */
const B = process.env.BASE ?? 'http://127.0.0.1:4123';
const ADMIN = { username: 'admin', password: process.env.ADMIN_PW ?? 'Floor2026Line#7' };

function jar() {
  let c = '';
  return {
    get: () => c,
    set: (res) => {
      const s = res.headers.getSetCookie?.() ?? [];
      if (s.length) c = s.map((x) => x.split(';')[0]).join('; ');
    },
  };
}

async function call(cookies, method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie: cookies.get() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  cookies.set(res);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const admin = jar();
const login = await call(admin, 'POST', '/api/auth/login', ADMIN);
if (login.status !== 200) { console.error('admin login failed', login); process.exit(1); }
console.log('admin signed in\n');

for (const [username, role, full] of [
  ['floor.test', 'production', 'Floor Operator'],
  ['store.test', 'store', 'Store Keeper'],
  ['merch.test', 'merchandiser', 'Merchandiser'],
]) {
  const res = await call(admin, 'POST', '/api/users', {
    username, full_name: full, email: '', roles: [role], is_active: 1,
    password: 'Testing#2026aa', must_change_pw: 0,
  });
  if (res.status !== 201 && res.status !== 409) { console.error('create failed', res); process.exit(1); }
}
console.log('test users ready\n');

// ---------------------------------------------------------------- production
{
  const u = jar();
  const r = await call(u, 'POST', '/api/auth/login', { username: 'floor.test', password: 'Testing#2026aa' });
  console.log('production role — logs cutting, sewing, checking:');
  check('can sign in', r.status === 200, `status ${r.status}`);
  check('can read cutting', (await call(u, 'GET', '/api/cutting?limit=1')).status === 200);

  for (const [label, path] of [
    ['costing list', '/api/costing'],
    ['a cost sheet', '/api/costing/order/HR-002'],
    ['rate library', '/api/rates'],
    ['buyer summary', '/api/buyer-summary'],
    ['user administration', '/api/users'],
    ['audit log', '/api/audit'],
    ['fabric store', '/api/fabric/stock'],
  ]) {
    const res = await call(u, 'GET', path);
    check(`${label} refused`, res.status === 403, `got ${res.status}`);
  }

  const write = await call(u, 'POST', '/api/costing/order/HR-002', {});
  check('cannot create a cost sheet', write.status === 403, `got ${write.status}`);
  console.log();
}

// --------------------------------------------------------------------- store
{
  const u = jar();
  await call(u, 'POST', '/api/auth/login', { username: 'store.test', password: 'Testing#2026aa' });
  console.log('store role — may see fabric, may not see what it is worth:');

  const stock = await call(u, 'GET', '/api/fabric/stock');
  check('can read the store', stock.status === 200);
  const row = stock.json?.rows?.[0];
  check('rate is absent from the payload, not merely hidden',
    row !== undefined && !('rate_per_kg' in row) && row.rate_per_kg__locked === true,
    row ? `money keys present: ${Object.keys(row).filter((k) => /rate|value/.test(k)).join(', ')}` : 'no rows');

  const ledger = await call(u, 'GET', '/api/fabric?limit=1');
  const lrow = ledger.json?.rows?.[0];
  check('ledger rate absent too',
    lrow !== undefined && !('rate_per_kg' in lrow) && lrow.rate_per_kg__locked === true);

  check('costing refused', (await call(u, 'GET', '/api/costing')).status === 403);
  console.log();
}

// ------------------------------------------------------------- merchandiser
{
  const u = jar();
  await call(u, 'POST', '/api/auth/login', { username: 'merch.test', password: 'Testing#2026aa' });
  console.log('merchandiser role — runs the order book, sees no money:');

  check('can read orders', (await call(u, 'GET', '/api/orders')).status === 200);

  const summary = await call(u, 'GET', '/api/buyer-summary');
  check('can read the buyer summary', summary.status === 200);
  const b = summary.json?.rows?.[0];
  check('commercial columns absent from the payload',
    b !== undefined && !('margin' in b) && !('order_value' in b) && b.margin__locked === true,
    b ? `money keys present: ${Object.keys(b).filter((k) => /^(margin|order_value|total_cost|avg_price|avg_cost)$/.test(k)).join(', ') || 'none'}` : 'no rows');

  check('costing refused', (await call(u, 'GET', '/api/costing')).status === 403);

  const role = await call(u, 'POST', '/api/roles', {
    code: 'sneaky', name: 'Sneaky', permissions: ['costing.view', 'costing.margin.view'],
  });
  check('cannot mint a role that grants themselves costing', role.status === 403, `got ${role.status}`);
  console.log();
}

// ------------------------------------------------------------- no session
{
  const anon = jar();
  console.log('with no session at all:');
  for (const [label, path] of [['dashboard', '/api/dashboard'], ['orders', '/api/orders'], ['costing', '/api/costing']]) {
    const res = await call(anon, 'GET', path);
    check(`${label} needs a session`, res.status === 401, `got ${res.status}`);
  }
  console.log();
}

const failed = checks.filter((c) => !c.pass);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
