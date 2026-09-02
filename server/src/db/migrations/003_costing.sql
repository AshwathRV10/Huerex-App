-- ===========================================================================
-- HUEREX GFES v6 · 003 costing
-- What a garment actually costs, against what it was sold for.
--
-- Quantity model (the thing spreadsheets always get wrong):
--   excess_qty      = order_qty * excess_pct           (buyer-specific, SHIPS with the order)
--   ship_qty        = order_qty + excess_qty
--   billable_qty    = order_qty + (excess billable ? excess_qty : 0)
--   production_qty  = ship_qty / (1 - rejection_pct)   (what the floor must make)
-- Material and CMT cost is incurred on production_qty.
-- Revenue is earned on billable_qty.
-- ===========================================================================

CREATE TABLE cost_sheets (
  id                    INTEGER PRIMARY KEY,
  order_id              INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL DEFAULT 1,
  label                 TEXT NOT NULL DEFAULT 'Quotation',   -- Quotation | Budget | Revised | Actual
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','submitted','approved','rejected','locked')),
  is_primary            INTEGER NOT NULL DEFAULT 1,          -- the version the dashboards read

  -- quantity basis, snapshotted so a historic sheet never silently re-bases
  order_qty             INTEGER NOT NULL DEFAULT 0,
  excess_pct            REAL NOT NULL DEFAULT 0,
  excess_billable       INTEGER NOT NULL DEFAULT 1,
  rejection_pct         REAL NOT NULL DEFAULT 0,

  -- commercial
  currency              TEXT NOT NULL DEFAULT 'INR',
  fx_rate               REAL NOT NULL DEFAULT 1,             -- 1 currency unit = fx_rate INR
  selling_price_per_pc  REAL NOT NULL DEFAULT 0,             -- in `currency`
  price_basis           TEXT NOT NULL DEFAULT 'FOB',         -- FOB | CIF | Ex-Works | DDP
  target_margin_pct     REAL NOT NULL DEFAULT 0,

  notes                 TEXT NOT NULL DEFAULT '',
  submitted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at          TEXT,
  approved_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at           TEXT,
  approval_note         TEXT NOT NULL DEFAULT '',
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_cs_version ON cost_sheets(order_id, version);
CREATE INDEX idx_cs_order ON cost_sheets(order_id);
CREATE INDEX idx_cs_status ON cost_sheets(status);

-- Price can differ by colour or size on the same order.
CREATE TABLE cost_sheet_prices (
  id             INTEGER PRIMARY KEY,
  cost_sheet_id  INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  colour         TEXT NOT NULL DEFAULT '',    -- '' = any
  size           TEXT NOT NULL DEFAULT '',    -- '' = any
  price_per_pc   REAL NOT NULL
);
CREATE UNIQUE INDEX idx_csp_key ON cost_sheet_prices(cost_sheet_id, colour, size);

-- ------------------------------------------------------------------- fabric
-- One line per fabric_type x colour actually used on this order.
-- Rate is NOT a single number: it is a build-up whose parts move independently
-- (knitting differs by fabric, dyeing differs by colour, printing by style).
CREATE TABLE cost_fabric_lines (
  id                   INTEGER PRIMARY KEY,
  cost_sheet_id        INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  fabric_type          TEXT NOT NULL,
  colour               TEXT NOT NULL DEFAULT '',        -- '' = applies to all colours
  part                 TEXT NOT NULL DEFAULT 'Body',    -- Body | Rib | Pocket | Hood lining ...
  gsm                  REAL NOT NULL DEFAULT 0,
  consumption_g_per_pc REAL NOT NULL DEFAULT 0,         -- net grams per garment
  wastage_pct          REAL NOT NULL DEFAULT 0,         -- cutting + process loss on top
  rate_mode            TEXT NOT NULL DEFAULT 'buildup' CHECK (rate_mode IN ('buildup','flat')),
  flat_rate_per_kg     REAL NOT NULL DEFAULT 0,         -- used when rate_mode='flat'
  applies_qty_pct      REAL NOT NULL DEFAULT 100,       -- % of pieces carrying this fabric
  supplier             TEXT NOT NULL DEFAULT '',
  remarks              TEXT NOT NULL DEFAULT '',
  sort_order           REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_cfl_sheet ON cost_fabric_lines(cost_sheet_id);

-- Yarn / Knitting / Dyeing / Compacting / Printing / anything the mill charges.
-- Component names are free text and are remembered, so a new one typed once is
-- offered forever after.
CREATE TABLE cost_fabric_components (
  id                 INTEGER PRIMARY KEY,
  fabric_line_id     INTEGER NOT NULL REFERENCES cost_fabric_lines(id) ON DELETE CASCADE,
  component          TEXT NOT NULL,                     -- Yarn | Knitting | Dyeing | Compacting | ...
  rate_per_kg        REAL NOT NULL DEFAULT 0,
  vendor             TEXT NOT NULL DEFAULT '',
  loss_pct           REAL NOT NULL DEFAULT 0,           -- process loss added at this stage
  remarks            TEXT NOT NULL DEFAULT '',
  sort_order         REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_cfc_line ON cost_fabric_components(fabric_line_id);

-- -------------------------------------------------------------------- trims
CREATE TABLE cost_trim_lines (
  id                 INTEGER PRIMARY KEY,
  cost_sheet_id      INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  trim_item          TEXT NOT NULL,
  colour             TEXT NOT NULL DEFAULT '',
  size               TEXT NOT NULL DEFAULT '',
  uom                TEXT NOT NULL DEFAULT 'pcs',
  qty_per_pc         REAL NOT NULL DEFAULT 1,
  rate_per_unit      REAL NOT NULL DEFAULT 0,
  wastage_pct        REAL NOT NULL DEFAULT 0,
  applies_qty_pct    REAL NOT NULL DEFAULT 100,
  supplier           TEXT NOT NULL DEFAULT '',
  remarks            TEXT NOT NULL DEFAULT '',
  sort_order         REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_ctl_sheet ON cost_trim_lines(cost_sheet_id);

-- ----------------------------------------------------------------- job work
-- Rate is per piece, per process, per vendor — and changes style to style.
CREATE TABLE cost_jobwork_lines (
  id                 INTEGER PRIMARY KEY,
  cost_sheet_id      INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  process            TEXT NOT NULL,
  vendor             TEXT NOT NULL DEFAULT '',
  colour             TEXT NOT NULL DEFAULT '',
  step_no            INTEGER,
  rate_per_pc        REAL NOT NULL DEFAULT 0,
  applies_qty_pct    REAL NOT NULL DEFAULT 100,   -- e.g. only front panels printed
  vendor_loss_pct    REAL NOT NULL DEFAULT 0,     -- pieces damaged at vendor we still pay for
  freight_per_order  REAL NOT NULL DEFAULT 0,
  remarks            TEXT NOT NULL DEFAULT '',
  sort_order         REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_cjl_sheet ON cost_jobwork_lines(cost_sheet_id);

-- ------------------------------------------------------------------ CMT
-- Cutting, sewing, fusing, ironing, checking, packing and anything else made
-- in-house. Sewing is usually costed from SAM x cost-per-minute.
CREATE TABLE cost_cmt_lines (
  id                 INTEGER PRIMARY KEY,
  cost_sheet_id      INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  operation          TEXT NOT NULL,               -- Cutting | Sewing | Fusing | Ironing | Checking | Packing | ...
  basis              TEXT NOT NULL DEFAULT 'per_pc'
                       CHECK (basis IN ('per_pc','per_order','per_sam_min','pct_of_cost')),
  rate               REAL NOT NULL DEFAULT 0,     -- ₹/pc, ₹/order, ₹/SAM-min, or %
  sam_min            REAL NOT NULL DEFAULT 0,     -- used when basis='per_sam_min'
  efficiency_pct     REAL NOT NULL DEFAULT 100,   -- 65% efficiency inflates the real minute cost
  applies_qty_pct    REAL NOT NULL DEFAULT 100,
  remarks            TEXT NOT NULL DEFAULT '',
  sort_order         REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_ccl_sheet ON cost_cmt_lines(cost_sheet_id);

-- --------------------------------------------------------------- overheads
-- Sampling, lab test, documentation, transportation, commission, finance...
CREATE TABLE cost_overhead_lines (
  id                 INTEGER PRIMARY KEY,
  cost_sheet_id      INTEGER NOT NULL REFERENCES cost_sheets(id) ON DELETE CASCADE,
  category           TEXT NOT NULL,               -- Sampling | Lab Test | Documentation | Transportation | ...
  basis              TEXT NOT NULL DEFAULT 'per_order'
                       CHECK (basis IN ('per_pc','per_order','pct_of_cost','pct_of_revenue')),
  amount             REAL NOT NULL DEFAULT 0,
  vendor             TEXT NOT NULL DEFAULT '',
  remarks            TEXT NOT NULL DEFAULT '',
  sort_order         REAL NOT NULL DEFAULT 1000
);
CREATE INDEX idx_col_sheet ON cost_overhead_lines(cost_sheet_id);

-- ===========================================================================
-- Rate memory · every rate ever typed, scored by how specific it is.
-- This is what makes the second order cheap to cost: the app proposes the rate
-- it has seen for this buyer / style / colour / vendor and shows where it
-- came from, but never forces it.
-- ===========================================================================
CREATE TABLE rate_memory (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,        -- fabric_component | fabric_flat | trim | jobwork | cmt | overhead | selling_price | consumption
  buyer          TEXT NOT NULL DEFAULT '',
  style          TEXT NOT NULL DEFAULT '',
  fabric_type    TEXT NOT NULL DEFAULT '',
  colour         TEXT NOT NULL DEFAULT '',
  trim_item      TEXT NOT NULL DEFAULT '',
  process        TEXT NOT NULL DEFAULT '',
  vendor         TEXT NOT NULL DEFAULT '',
  component      TEXT NOT NULL DEFAULT '',
  operation      TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT '',
  uom            TEXT NOT NULL DEFAULT '',
  rate           REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  use_count      INTEGER NOT NULL DEFAULT 1,
  last_used_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_order_no  TEXT NOT NULL DEFAULT '',
  first_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_rm_key ON rate_memory(
  kind, buyer, style, fabric_type, colour, trim_item, process, vendor, component, operation, category, uom
);
CREATE INDEX idx_rm_lookup ON rate_memory(kind, last_used_at DESC);

-- Every accepted rate keeps its trail, so "why is this order dearer" is answerable.
CREATE TABLE rate_history (
  id             INTEGER PRIMARY KEY,
  rate_memory_id INTEGER REFERENCES rate_memory(id) ON DELETE CASCADE,
  order_no       TEXT NOT NULL DEFAULT '',
  cost_sheet_id  INTEGER,
  rate           REAL NOT NULL,
  previous_rate  REAL,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_rh_mem ON rate_history(rate_memory_id, at DESC);

-- Reusable starting points: "the hoodie template", "the basic tee template".
CREATE TABLE cost_templates (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  buyer        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
