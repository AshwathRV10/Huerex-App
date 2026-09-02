-- ===========================================================================
-- HUEREX GFES v6 · 002 execution
-- Orders, route, colour x size matrix and every transaction sheet.
-- One row per transaction. Nothing derived is stored.
-- ===========================================================================

CREATE TABLE orders (
  id                  INTEGER PRIMARY KEY,
  order_no            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  buyer               TEXT NOT NULL,
  style               TEXT NOT NULL DEFAULT '',
  style_ref           TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  order_qty           INTEGER NOT NULL DEFAULT 0,
  order_date          TEXT,
  ex_factory_date     TEXT,
  sew_complete_by     TEXT,
  sam                 REAL NOT NULL DEFAULT 0,
  buffer_pct          REAL NOT NULL DEFAULT 0.05,   -- cutting buffer
  excess_pct          REAL,                          -- null => inherit from buyer
  merchandiser        TEXT NOT NULL DEFAULT '',
  planner             TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'Active',
  set_group           TEXT NOT NULL DEFAULT '',
  set_role            TEXT NOT NULL DEFAULT '',
  fabric_lead_days    INTEGER,
  currency            TEXT NOT NULL DEFAULT 'INR',
  fx_rate             REAL NOT NULL DEFAULT 1,       -- 1 unit of currency = fx_rate INR
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_buyer ON orders(buyer);
CREATE INDEX idx_orders_status ON orders(status);

-- The exact sequence this order travels. Any sequence is allowed; a process
-- may appear more than once, which is why the PK is (order, step_no).
CREATE TABLE order_route (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  step_no     INTEGER NOT NULL,
  process     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'In-house' CHECK (type IN ('In-house','Outsourced')),
  notes       TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_route_step ON order_route(order_id, step_no);
CREATE INDEX idx_route_process ON order_route(order_id, process);

CREATE TABLE order_matrix (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour          TEXT NOT NULL,
  size            TEXT NOT NULL,
  order_qty       INTEGER NOT NULL DEFAULT 0,
  recut_decision  TEXT NOT NULL DEFAULT '-',
  sort_order      REAL NOT NULL DEFAULT 1000
);
CREATE UNIQUE INDEX idx_matrix_key ON order_matrix(order_id, colour, size);
CREATE INDEX idx_matrix_order ON order_matrix(order_id);

-- ------------------------------------------------------------- fabric store
-- A real store ledger: every movement, and therefore a live balance.
-- Stock is held by (fabric_type, colour, lot) and may be allocated to an order
-- or sit free in the store.
CREATE TABLE fabric_ledger (
  id              INTEGER PRIMARY KEY,
  txn_date        TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('RECEIPT','ISSUE','RETURN','ADJUST','TRANSFER_OUT','TRANSFER_IN')),
  fabric_type     TEXT NOT NULL,
  colour          TEXT NOT NULL,
  lot_no          TEXT NOT NULL DEFAULT '',
  order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL, -- null = free stock
  counter_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL, -- for transfers
  qty_kg          REAL NOT NULL,               -- always positive; direction gives the sign
  rate_per_kg     REAL,                        -- costed at receipt
  supplier        TEXT NOT NULL DEFAULT '',
  dc_no           TEXT NOT NULL DEFAULT '',
  remarks         TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fabric_order ON fabric_ledger(order_id);
CREATE INDEX idx_fabric_stock ON fabric_ledger(fabric_type, colour, lot_no);
CREATE INDEX idx_fabric_date ON fabric_ledger(txn_date);

-- Re-weighed actual consumption, entered only when the store has counted.
CREATE TABLE fabric_manual_consumption (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  fabric_type   TEXT NOT NULL,
  colour        TEXT NOT NULL,
  consumed_kg   REAL NOT NULL,
  as_of_date    TEXT NOT NULL,
  remarks       TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_fmc_key ON fabric_manual_consumption(order_id, fabric_type, colour);

-- -------------------------------------------------------------------- trims
CREATE TABLE trims (
  id              INTEGER PRIMARY KEY,
  txn_date        TEXT NOT NULL,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  trim_item       TEXT NOT NULL,
  colour          TEXT NOT NULL DEFAULT '',
  required_qty    REAL NOT NULL DEFAULT 0,
  received_qty    REAL NOT NULL DEFAULT 0,
  issued_qty      REAL NOT NULL DEFAULT 0,
  uom             TEXT NOT NULL DEFAULT 'pcs',
  blocks_packing  INTEGER NOT NULL DEFAULT 0,
  supplier        TEXT NOT NULL DEFAULT '',
  remarks         TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trims_order ON trims(order_id, trim_item);

-- ----------------------------------------------------------------- job work
CREATE TABLE job_work (
  id            INTEGER PRIMARY KEY,
  txn_date      TEXT NOT NULL,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour        TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT '',
  process       TEXT NOT NULL,
  step_no       INTEGER,                       -- which route step, when a process repeats
  vendor        TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('OUT','IN')),
  qty           INTEGER NOT NULL,
  dc_no         TEXT NOT NULL DEFAULT '',
  remarks       TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jw_order ON job_work(order_id, process, colour, size);
CREATE INDEX idx_jw_dir ON job_work(direction);

-- ------------------------------------------------------------------ cutting
CREATE TABLE cutting (
  id                INTEGER PRIMARY KEY,
  txn_date          TEXT NOT NULL,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour            TEXT NOT NULL,
  size              TEXT NOT NULL,
  fabric_type       TEXT NOT NULL DEFAULT '',
  counts_as_garment INTEGER NOT NULL DEFAULT 1,
  lot_no            TEXT NOT NULL DEFAULT '',
  cut_qty           INTEGER NOT NULL,
  fabric_gsm        REAL,
  area_per_pc_sqm   REAL,
  pc_weight_g       REAL,
  table_no          TEXT NOT NULL DEFAULT '',
  remarks           TEXT NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cut_order ON cutting(order_id, colour, size);
CREATE INDEX idx_cut_date ON cutting(txn_date);

-- ------------------------------------------------------------------- fusing
CREATE TABLE fusing (
  id          INTEGER PRIMARY KEY,
  txn_date    TEXT NOT NULL,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour      TEXT NOT NULL,
  size        TEXT NOT NULL,
  fused_qty   INTEGER NOT NULL,
  remarks     TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fuse_order ON fusing(order_id, colour, size);

-- ------------------------------------------------------------------- sewing
-- Output is logged by line and daily block. Colour/size is optional: fill it
-- and WIP is exact, leave it blank and WIP prorates across what is available.
CREATE TABLE sewing (
  id              INTEGER PRIMARY KEY,
  txn_date        TEXT NOT NULL,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line            TEXT NOT NULL,
  colour          TEXT NOT NULL DEFAULT '',
  size            TEXT NOT NULL DEFAULT '',
  operators       REAL NOT NULL DEFAULT 0,
  hours           REAL NOT NULL DEFAULT 0,
  block1          INTEGER NOT NULL DEFAULT 0,
  block2          INTEGER NOT NULL DEFAULT 0,
  block3          INTEGER NOT NULL DEFAULT 0,
  issued_to_line  INTEGER NOT NULL DEFAULT 0,
  remarks         TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sew_order ON sewing(order_id);
CREATE INDEX idx_sew_date ON sewing(txn_date);

-- --------------------------------------------------------------- checking
CREATE TABLE checking (
  id              INTEGER PRIMARY KEY,
  txn_date        TEXT NOT NULL,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour          TEXT NOT NULL,
  size            TEXT NOT NULL,
  line            TEXT NOT NULL DEFAULT '',
  checked_qty     INTEGER NOT NULL DEFAULT 0,
  pass_qty        INTEGER NOT NULL DEFAULT 0,
  alter_qty       INTEGER NOT NULL DEFAULT 0,
  reject_qty      INTEGER NOT NULL DEFAULT 0,
  rechecked_ok    INTEGER NOT NULL DEFAULT 0,
  defect_notes    TEXT NOT NULL DEFAULT '',
  remarks         TEXT NOT NULL DEFAULT '',
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chk_order ON checking(order_id, colour, size);

-- ---------------------------------------------------------------- packing
CREATE TABLE packing (
  id          INTEGER PRIMARY KEY,
  txn_date    TEXT NOT NULL,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour      TEXT NOT NULL,
  size        TEXT NOT NULL,
  packed_qty  INTEGER NOT NULL,
  carton_no   TEXT NOT NULL DEFAULT '',
  remarks     TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pack_order ON packing(order_id, colour, size);

-- ------------------------------------------------------- final inspection
CREATE TABLE inspection (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inspection_date   TEXT NOT NULL,
  offered_qty       INTEGER NOT NULL DEFAULT 0,
  result            TEXT NOT NULL DEFAULT 'Pending',
  aql               TEXT NOT NULL DEFAULT '',
  inspector         TEXT NOT NULL DEFAULT '',
  remarks           TEXT NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_insp_order ON inspection(order_id);

-- --------------------------------------------------------------- shipment
CREATE TABLE shipment (
  id            INTEGER PRIMARY KEY,
  txn_date      TEXT NOT NULL,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  colour        TEXT NOT NULL,
  size          TEXT NOT NULL,
  ship_qty      INTEGER NOT NULL,
  invoice_no    TEXT NOT NULL DEFAULT '',
  buyer_po_no   TEXT NOT NULL DEFAULT '',
  cartons       REAL NOT NULL DEFAULT 0,
  gross_wt_kg   REAL NOT NULL DEFAULT 0,
  net_wt_kg     REAL NOT NULL DEFAULT 0,
  remarks       TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ship_order ON shipment(order_id, colour, size);

-- ------------------------------------------------------- buyer approvals
CREATE TABLE buyer_approvals (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  approval_type     TEXT NOT NULL,
  required          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'Pending',
  sent_date         TEXT,
  decided_date      TEXT,
  blocks_production INTEGER NOT NULL DEFAULT 0,
  owner             TEXT NOT NULL DEFAULT '',
  remarks           TEXT NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_appr_key ON buyer_approvals(order_id, approval_type);

-- -------------------------------------------- management alert waivers
CREATE TABLE alert_waivers (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  alert_type    TEXT NOT NULL,
  approved      INTEGER NOT NULL DEFAULT 0,
  approved_by   TEXT NOT NULL DEFAULT '',
  approved_at   TEXT,
  reason        TEXT NOT NULL DEFAULT '',
  valid_until   TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_waiver_key ON alert_waivers(order_id, alert_type);

-- ----------------------------------------------- delay reason on timeline
CREATE TABLE order_delay_reason (
  order_id    INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL DEFAULT '-',
  note        TEXT NOT NULL DEFAULT '',
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
