# HUEREX · Garment Factory Execution System

The V5.1 workbook, rebuilt as an application — and extended with the thing it
could never do: **what a garment actually costs to make, against what it was
sold for.**

One Node process, one SQLite file, no cloud dependency. Unplug the internet
and the factory keeps running.

[![CI](https://github.com/AshwathRV10/Huerex-App/actions/workflows/ci.yml/badge.svg)](https://github.com/AshwathRV10/Huerex-App/actions/workflows/ci.yml)

---

## Getting it running

```bash
npm install
npm run build
npm run seed     # prints a one-time admin password
npm start        # http://localhost:4000
```

Seeding loads the workbook's own data — sixteen orders, their routes, the size
breakdowns, 180 job-work movements, 74 cutting entries — so there is something
real on every screen from the first minute. It only does that when the
database is empty, so re-running it on a live installation is safe.

Full instructions, including systemd, Docker and reaching it from outside the
factory: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## What it does

### Everything the workbook did

- **Route-driven WIP.** Every order travels its own sequence, so fusing after
  sewing, a print twice, or an order that skips inspection all work. Buckets
  are derived by walking that route — nothing is hard-coded to a column.
- **`Cut = Shipped + Rejected + WIP`**, checked per colour and size. When the
  buckets disagree with the identity, the difference is reported rather than
  hidden, because it means one entry contradicts another.
- **Alerts** with management waivers: an accepted alert is suppressed until
  the date set, never deleted, and the dashboard still counts it.
- **Order timeline, reconciliation, capacity, data audit, buyer summary** —
  all derived on read, so there is one truth per number.

### What is new

**Costing.** Per garment, per order, per style — the headline addition:

- Fabric as a **build-up** — yarn, knitting, dyeing, compacting — because
  dyeing moves with the colour and knitting with the fabric, and one ₹/kg
  figure cannot say that.
- Trims per piece, job work per process per vendor, CMT per operation
  (including sewing at SAM ÷ real efficiency), and other costs — sampling,
  lab, documentation, transport — on four bases.
- **Excess handled honestly**: it ships in the same cartons, the percentage is
  the buyer's, and whether they pay for it decides whether it is revenue or a
  gift. Rejection is separate — made, paid for, never shipped.
- **Rate memory.** Every rate is remembered against the context it was used
  in and offered back with its provenance: *"₹186 · dyeing, PINK — used on
  HR-014, three weeks ago"*. The second order costs itself.
- **Plan against actual**, using the kilograms the store really issued and the
  pieces the vendors really got.

Seeding adds about a dozen **starting-point rates** so the first sheet is not
a page of zeroes. Nobody has quoted them, so they are marked in amber
everywhere they appear and the marker only clears when somebody types a
different number. Replace them before any sheet reaches a buyer.

**[docs/COSTING.md](docs/COSTING.md)** explains the model.

**A fabric store with a balance.** The workbook could show kilograms in and
kilograms consumed but never what was left on the shelf. Now the balance leads
the screen, issuing more than the store holds is refused, and re-weighed
consumption overrides the derived figure.

**Access control that is actually enforced.** Module, screen, field and action
level, checked on the server. A restricted figure is not hidden in the
browser — it never leaves the machine. Deleting an order is Administrator and
Management only, refused until confirmed by name when the floor has worked on
it, and recorded in the audit log with everything that went with it.
**[docs/SECURITY.md](docs/SECURITY.md)**, and `npm run test:rbac` proves it
against a running server.

**Notifications.** A blocked order used to wait until somebody thought to open
the approvals page. Now it finds its owner.

**Screens that work on a phone.** Wide tables collapse to labelled cards below
900px, controls grow to a thumb, and Save moves into a fixed bar at the bottom
— because the cutting table does not have a laptop on it.

**Nightly backups** to a folder you choose, with tiered retention, using
SQLite's `VACUUM INTO` so nothing has to stop.

---

## How it is put together

```
server/
  src/
    engine/           the arithmetic, pure and tested
      costing.ts        cost build-up, quantities, margin
      flow.ts           the route walk that produces WIP
      alerts.ts         seventeen rules, with waivers
      facts.ts          loads what the engines need
    rbac/             the permission catalogue and the guards
    modules/          one file per area, all HTTP
    db/migrations/    three .sql files, applied in order
web/
  src/
    components/       the shared pieces: combobox, bulk grid, entry page
    pages/            one file per screen
    styles/           tokens, base, components, layout
  public/fonts/       Inter, self-hosted
docs/
```

The two engines are pure functions of their input, which is why they can be
tested without a database:

```bash
npm test          # 31 tests over the costing maths and the route walk
npm run test:rbac # 37 checks that access control holds, against a live server
npm run test:e2e  # 30 browser tests that drive the real screens
npm run typecheck
```

All four run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Two of them need a
running application rather than a test harness, which is why that file has
three jobs: `test:rbac` signs in over HTTP to prove a restricted figure never
leaves the machine, and `test:e2e` drives Chromium through the built
application to prove the screens still work — including at 390px, where the
grid becomes cards and Save moves under the thumb.

The browser tests reseed a throwaway database on every run, so they can assert
on known state: an order that has never been costed, a rate library still
holding starting points. They need a build first, because they drive
`server/dist/index.js` — the same single process the factory runs — not a dev
server.

### Ideas the code is built on

**Nothing derived is stored.** WIP, cost totals, cycle times and alerts are
computed on read. A stale number is worse than a millisecond of work.

**One screen per shape, not per table.** Every transaction sheet is a column
declaration on top of one entry component, so bulk entry, carry-forward,
paste-from-spreadsheet, validation, the audit trail and the mobile layout
cannot drift apart between screens.

**Messages are written for the person at the machine.** *"Only 62 pcs are
still out at GAIN UP EMBROIDERY for Embroidery. Receiving 80 would mean more
came back than went."* — not `constraint violation`.

**Refuse, don't warn.** Packing that a short trim blocks, shipping before
inspection passes, issuing fabric the store does not hold, checking that does
not tally: all refused at the point of entry, with the reason.

---

## Day to day

| To | Go to |
| --- | --- |
| See what needs a decision | Dashboard |
| Start an order | Orders → New order, then Route and Colour × size |
| Cost it | Cost sheets → pick the order |
| Log the floor | Cutting, Job work, Sewing, Checking, Packing, Shipment |
| Find where a pile is stuck | WIP on floor |
| Check the numbers can be trusted | Data audit, then Reconciliation |
| Change who can see what | Users & roles |
| Check the backup ran | Settings & backup |

`⌘K` anywhere searches orders and jumps to any screen.
