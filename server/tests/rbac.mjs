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
    // Only declare a JSON body when there is one. Sending the content-type on
    // a bodyless DELETE makes Fastify reject it at 400 before any route runs,
    // which would hide the status the permission check actually returns — and
    // the browser client does not send it either.
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'sec-fetch-site': 'same-origin',
      cookie: cookies.get(),
    },
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
  ['costing.test', 'costing', 'Costing Clerk'],
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

  // Deleting an order is for administrators and management only. A
  // merchandiser runs the order book all day and must not be able to remove
  // one, by the API or by guessing the URL.
  const del = await call(u, 'DELETE', '/api/orders/HR-002');
  check('cannot delete an order', del.status === 403, `got ${del.status}`);
  const forced = await call(u, 'DELETE', '/api/orders/HR-002?confirm=HR-002');
  check('cannot delete an order by supplying the confirmation itself',
    forced.status === 403, `got ${forced.status}`);
  // Vendors are master data the whole factory reads; editing one is not.
  const vendors = await call(admin, 'GET', '/api/vendors');
  const vendorId = (vendors.json?.rows ?? [])[0]?.id;
  if (vendorId) {
    check('can read vendors', (await call(u, 'GET', '/api/vendors')).status === 200);
    const edit = await call(u, 'PATCH', `/api/vendors/${vendorId}`, { contact: 'not mine to set' });
    check('cannot edit a vendor', edit.status === 403, `got ${edit.status}`);
  }

  // The rate library is the record of why orders were priced the way they were.
  const wipe = await call(u, 'DELETE', '/api/rates/1');
  check('cannot forget a remembered rate', wipe.status === 403, `got ${wipe.status}`);

  // Reading a floor sheet is not permission to rewrite yesterday's entry.
  const someJobWork = await call(admin, 'GET', '/api/jobwork?order_no=HR-002&limit=1');
  const rowId = (someJobWork.json?.rows ?? [])[0]?.id;
  if (rowId) {
    check('can read job work', (await call(u, 'GET', '/api/jobwork?limit=1')).status === 200);
    const edit = await call(u, 'PATCH', `/api/jobwork/${rowId}`, { remarks: 'not mine to change' });
    check('cannot correct a job-work entry', edit.status === 403, `got ${edit.status}`);
  }

  const preview = await call(u, 'GET', '/api/orders/HR-002/delete-preview');
  check('cannot even see what deleting one would remove', preview.status === 403, `got ${preview.status}`);
  check('and the order is still there',
    (await call(u, 'GET', '/api/orders/HR-002')).status === 200);
  console.log();
}

// ------------------------------------------------- deleting orders, allowed
{
  console.log('an administrator deleting an order:');

  // An order with production against it is refused until it is confirmed by
  // name, so a stray DELETE cannot take the floor's history with it.
  const withHistory = await call(admin, 'DELETE', '/api/orders/HR-002');
  check('an order with history is refused without confirmation',
    withHistory.status === 409 && withHistory.json?.code === 'needs_confirmation',
    `got ${withHistory.status} ${withHistory.json?.code ?? ''}`);
  check('the refusal names what would be lost',
    typeof withHistory.json?.error === 'string' && /cutting entries|job-work movements/.test(withHistory.json.error),
    withHistory.json?.error?.slice(0, 80));
  check('and it survived being refused',
    (await call(admin, 'GET', '/api/orders/HR-002')).status === 200);

  check('a wrong confirmation is still refused',
    (await call(admin, 'DELETE', '/api/orders/HR-002?confirm=HR-003')).status === 409);

  // A fresh order nobody has touched goes without ceremony.
  const made = await call(admin, 'POST', '/api/orders', {
    order_no: 'E2E-DELETE-ME', buyer: 'BABY SHOP - VIGASH', style: 'throwaway',
    order_qty: 10, status: 'Active',
  });
  check('a throwaway order can be created', made.status === 201, `got ${made.status}`);
  const clean = await call(admin, 'DELETE', '/api/orders/E2E-DELETE-ME');
  check('an order with no history deletes without confirmation', clean.status === 200, `got ${clean.status}`);
  check('and it is gone', (await call(admin, 'GET', '/api/orders/E2E-DELETE-ME')).status === 404);

  const trail = await call(admin, 'GET', '/api/audit?entity=orders&action=delete');
  const rows = trail.json?.rows ?? trail.json ?? [];
  check('the deletion is in the audit log',
    Array.isArray(rows) && rows.some((r) => String(r.summary ?? '').includes('E2E-DELETE-ME')),
    `${Array.isArray(rows) ? rows.length : 0} delete rows`);
  console.log();
}

// ------------------------------------------- costing, who owns the library
{
  const u = jar();
  await call(u, 'POST', '/api/auth/login', { username: 'costing.test', password: 'Testing#2026aa' });
  console.log('costing role — builds cost sheets and owns the rate library:');

  check('can read the rate library', (await call(u, 'GET', '/api/rates?limit=1')).status === 200);
  check('can see cost and margin', (await call(u, 'GET', '/api/costing')).status === 200);

  // Owning the library includes tidying it: a rate typed against the wrong
  // vendor is this role's to clear up.
  const rates = await call(admin, 'GET', '/api/rates?limit=1');
  const rateId = (Array.isArray(rates.json) ? rates.json : rates.json?.rows ?? [])[0]?.id;
  if (rateId) {
    const gone = await call(u, 'DELETE', `/api/rates/${rateId}`);
    check('can forget a remembered rate', gone.status === 200, `got ${gone.status}`);
  }

  // But the library is not the user list.
  check('still refused user administration', (await call(u, 'GET', '/api/users')).status === 403);
  check('still refused the audit log', (await call(u, 'GET', '/api/audit')).status === 403);
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
