# Access, and how it is enforced

The requirement was that unauthorised people have **no** access to costing
data — not to reports, not to exports, not to APIs, not to a URL typed
directly, not to the database rows behind them. This is how that is done.

---

## The shape of a permission

```
orders.view                     a screen and an action
orders.excess_pct.view          one field on that screen
costing.margin.view             one figure inside a screen
```

Every legal key is declared in `server/src/rbac/permissions.ts`, and nothing
in the application may check for a key that is not declared there. A typo
fails at startup rather than quietly granting or denying access — and a role
that grants a key the catalogue does not contain is refused at import, because
such a grant can never match a check while still breaking the escalation rule
below.

Actions are `view`, `create`, `edit`, `delete`, `approve`, `export`. Each
module declares only the ones that make sense for it: the route editor has no
export, buyer approvals have `approve` instead of `export`.

---

## Four layers, and only three of them are real

1. **The menu** hides screens you cannot open. A courtesy.
2. **The screen** hides buttons you cannot use. Also a courtesy.
3. **The route guard** shows "this screen is not part of your role" when a URL
   is typed directly. Still only the browser.
4. **The server** refuses the request. **This is the control.**

Every endpoint calls `assertPermission` before it does anything. Typing the
URL, calling the API with curl, or replaying a request from another account's
browser all end the same way: `403`, and nothing in the body.

`server/tests/rbac.mjs` proves it. It signs in as a real production user with
a real session cookie and confirms the costing API, the rate library, the
buyer summary, user administration and the audit log are all refused — and
that the same user cannot create a cost sheet either.

```bash
npm run test:rbac
```

---

## Field-level access

Some screens are shared but some columns are not. A store keeper needs the
fabric ledger; they do not need to know what the fabric is worth.

The value **is not sent**. The server deletes the key from the response and
puts `<field>__locked: true` in its place, so the browser can render a lock
where the number would be, and can tell a withheld figure apart from a genuine
zero. There is nothing in the payload to inspect, nothing in the network tab,
and nothing in an export.

Currently protected this way:

| Field | Permission |
| --- | --- |
| Fabric rate and stock value | `fabric.rate_per_kg.view`, `fabric.value.view` |
| Trim rate | `trims.rate.view` |
| Job work rate | `jobwork.rate_per_pc.view` |
| Order excess % and FX rate | `orders.excess_pct.view`, `orders.fx_rate.view` |
| Every costing block, total, price and margin | `costing.*.view` |
| Buyer summary value, cost and margin | `buyersummary.commercials.view` |

Writes are filtered the same way. A save that omits a block the caller cannot
edit leaves that block as it was, rather than blanking it.

---

## Roles

Nine come as standard, and all nine are ordinary editable rows afterwards:

| Role | Sees |
| --- | --- |
| Administrator | everything, including users and settings |
| Management | every number including cost and margin; approves |
| Costing & Commercial | cost sheets and the rate library; no user administration |
| Merchandiser | the order book and buyer approvals; **no cost or margin** |
| Planner | route, capacity, the production plan; no commercial data |
| Production / Floor | logs what happened; **cannot see any rate** |
| Store / Materials | fabric and trim movements and the store balance |
| Quality | checking, rework, final inspection |
| Read Only | production progress; no entry, no rates |

Make your own on **Users & roles → Roles**, which lays out the whole
catalogue module by module with the restricted fields listed under each.

**Per-person overrides** sit on top: one extra permission for one person, or
one taken away. A deny always beats an allow, so a carve-out for a single
individual never has to become a whole new role.

---

## Two rules the server will not let you break

**Nobody can grant access they do not hold themselves.** Creating a role,
editing one, or assigning one is checked against the editor's own permissions.
Someone who cannot see margin cannot make a role that can and then assign it
to themselves.

**The last administrator cannot be disabled or demoted.** Discovering that at
two in the morning is not a good experience.

Changing a role signs out everyone holding it, so the change takes effect at
once rather than at the end of their shift.

---

## Sign-in

- **Argon2id** password hashing, tuned so a login costs about 100 ms on a
  small LAN box and an offline attack on a stolen database file is expensive.
- **Session cookies** are `HttpOnly`, `SameSite=Lax`, and `Secure` when TLS is
  in front. The session id is **stored hashed**, so a copy of the database
  cannot be used to replay a live session.
- **Idle timeout** — four hours by default, because an unattended terminal on
  the floor should not stay open.
- **Lockout** after eight failed attempts, and the message says how long is
  left rather than leaving somebody guessing.
- **The same answer for a wrong username and a wrong password**, taking the
  same work either way, so accounts cannot be enumerated.
- **Optional two-factor sign-in** (TOTP), per person, on Account & security.
  Worth turning on for anyone who can see cost or margin.
- **Temporary passwords** are generated, shown once, never stored in the
  clear, and must be replaced at first sign-in.

---

## Audit

Every sensitive action is recorded with who, when, what, from where, and — for
an edit — **only the fields that actually changed**, before and after.

Always recorded: create, update, delete, login, failed login, lockout,
approve, reject, submit, export, password change, role change, permission
change, settings change, backup.

Passwords, password hashes and TOTP secrets are never written to the trail,
even when they are what changed.

**Audit log** filters by date, person, action, severity and free text, and any
row that carries a change opens a before-and-after view. An order, a cost
sheet or a user can be asked for its own history.

---

## Cross-site and content

- A write with a session cookie must also carry a same-origin marker, so a
  form post from another site is refused before it reaches a handler.
- A strict Content-Security-Policy: scripts and styles from this origin only,
  no framing, no object embedding, no external anything. That policy is tight
  enough to be worth having precisely because the fonts are self-hosted and
  nothing loads from a CDN.
- CSV exports escape cells beginning with `=`, `+`, `-` or `@`, so an export
  cannot carry a formula into somebody's spreadsheet.
- Every input is validated against a schema before it reaches the database,
  and every query is parameterised.

---

## What this does not do

Worth being straight about:

- **No encryption at rest.** Anyone with the `.sqlite` file has the data.
  Protect it with disk encryption and file permissions.
- **No single sign-on.** Accounts are local. For a factory of this size that
  is a feature; for an enterprise rollout it would need adding.
- **Backups are not encrypted.** If they go somewhere shared, encrypt the
  folder.
- **Availability is not addressed.** One machine, one process. That is the
  right trade for a factory LAN, but it means a nightly backup you have
  actually tested restoring is the whole disaster plan.
