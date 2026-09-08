-- The fabric plan: what has to be bought, decided when the order is taken.
--
-- This is planning, not costing. It is filled in the moment an order lands,
-- long before any cloth exists, and answers one question: how many kilograms
-- of yarn do we procure? A merchant works it out on paper as
--
--     pieces × grammage = fabric needed, + excess % = yarn to buy
--
-- and then has no record of it anywhere. Holding it here means the cost sheet
-- can be built from the same figures rather than re-typed, and — once the
-- cloth is in — what actually arrived can be measured against what was taken.
--
-- One row per fabric, because an order is rarely one cloth: a tee is a body in
-- single jersey with a 1×1 rib collar, and a jacket adds fleece. Each has its
-- own grammage and its own excess, since a dark shade loses more in dyeing
-- than a pastel does.

CREATE TABLE order_fabrics (
  id                INTEGER PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL DEFAULT 0,        -- the order they are shown in
  fabric_type       TEXT    NOT NULL,
  colour            TEXT    NOT NULL DEFAULT '',       -- blank = every colour
  part              TEXT    NOT NULL DEFAULT 'Body',
  grammage_g_per_pc REAL    NOT NULL DEFAULT 0,        -- finished cloth per garment
  excess_pct        REAL    NOT NULL DEFAULT 0,        -- process loss, yarn over fabric
  notes             TEXT    NOT NULL DEFAULT '',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The same cloth in the same colour for the same part is one line, not two.
CREATE UNIQUE INDEX idx_order_fabric ON order_fabrics(order_id, fabric_type, colour, part);
CREATE INDEX idx_order_fabric_order ON order_fabrics(order_id, seq);
