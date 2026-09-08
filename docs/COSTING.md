# What a garment costs

This is the part the spreadsheet never had: what an order actually costs to
make, set against what it was sold for.

---

## The quantity model

Most costing goes wrong before a single rate is entered, because it uses one
quantity for everything. Four different numbers matter, and they are all
different:

```
excess_qty      = order_qty × excess %              buyer-specific
ship_qty        = order_qty + excess_qty            what leaves the gate
billable_qty    = order_qty + excess_qty when the buyer pays for excess,
                  otherwise order_qty               what earns money
production_qty  = ship_qty ÷ (1 − rejection %)      what the floor must make
```

**Excess is not spare stock.** It goes in the same cartons as the order, so it
is cut, sewn, checked, packed and shipped. It costs money. Whether it *earns*
money depends on the buyer, which is why the rule lives on the buyer record
(Buyers & vendors → Excess) and every cost sheet inherits it.

**Rejection is different again.** Those pieces are made and paid for and never
leave. Allowing 2% means the floor has to make 1,021 garments to ship 1,000.

The cost sheet shows all five figures side by side, so nobody has to hold the
arithmetic in their head. They are worked out by the costing engine on the
server rather than duplicated in the browser — one source of truth for every
number — so the strip answers when the sheet is saved:

| | |
| --- | --- |
| Ordered | what the buyer asked for |
| Excess | at this buyer's rule |
| Ships | leaves the gate |
| Invoiced | order plus excess, or order alone |
| Must be made | including the rejection allowance |

Material and CMT are charged on **must be made**. Revenue is earned on
**invoiced**. Cost per garment is quoted against **ships**, because that is
how many garments the buyer receives.

---

## The fabric plan — decided with the order

Before any cloth exists, somebody has to say how much yarn to book. That sum
lives on the order, one line per cloth, on its **Fabric plan** tab:

```
                                    pieces × g/pc = cloth   + excess = yarn
Single Jersey · Navy   · Body    88 g/pc    88.0 kg    10%     96.8 kg
1×1 Rib       · Navy   · Collar  10 g/pc    10.0 kg    10%     11.0 kg
                                 Total      98.0 kg            107.8 kg
```

The grammage is finished cloth per garment, worked out from the GSM and the
body spec. The excess is **process loss** — what disappears between the yarn
going out and the cloth coming back, in knitting, dyeing and washing. It is
not cutting loss, which happens to cloth that has already arrived and belongs
on the cost sheet. Putting the same loss in both places prices the order about
ten per cent over.

Each fabric carries its own excess, because a dark shade loses more in dyeing
than a pastel does.

The pieces are the order **plus the excess that ships with it**, since those
garments are cut from the same rolls.

### It feeds the cost sheet

A sheet proposed for an order that has a plan takes its fabric lines from it —
the cloth, the shade, the part and the grammage — instead of guessing from
whatever was last cut. The draft says so, so nobody mistakes a figure a person
chose for one the app invented.

### And it gets measured

As cloth is booked into the fabric store against the order, what arrived is
compared with what was taken:

```
Single Jersey  yarn taken 96.8 kg   cloth in 88.2 kg   loss 8.88%   planned 10%
```

The comparison is drawn at fabric and shade rather than per line, because the
store books a receipt against a cloth and a colour and nothing finer — a body
and a collar in the same shade arrive on the same roll.

After a few orders the excess stops being a rule of thumb: navy on this jersey
runs at twelve per cent, whatever anybody says it should.

## Fabric — a build-up, not a rate

The brief that started this was specific: *dyeing rates vary colour to colour,
knitting rates differ fabric to fabric, and printing changes style to style.*
A single ₹/kg figure cannot express that, so fabric is costed as a build-up:

```
Yarn         ₹260 /kg
Knitting      ₹45 /kg      moves with the fabric
Dyeing        ₹96 /kg      moves with the colour
Compacting    ₹18 /kg
                    ------
                  ₹419 /kg
```

### The components are a route, not a basket

List them in the order the cloth actually travels — yarn is knitted, the grey
is dyed, the dyed cloth is washed and compacted. The order matters, and the
screen numbers the steps and lets you move them, because the arithmetic
depends on it.

Each component carries its own **process loss**: the weight that physically
disappears at that stage. Every processor bills on the weight sent *in*, so a
loss anywhere means more weight had to be bought and put through every stage
before it. A component's charge is therefore spread over the cloth that
survives to the end — its own loss and every loss still to come.

The consequence catches people out: **a stage with no loss of its own still
costs more than its ₹/kg.** Yarn does not shrink in the godown, but a finished
kilogram needed more than a kilogram of yarn, so that is what the yarn in it
costs.

```
Yarn        ₹320 /kg   0% loss    →  ₹354.42   1 kg finished needs 1.108 kg yarn
Knitting     ₹10 /kg   1% loss    →   ₹11.08
Dyeing       ₹60 /kg   4% loss    →   ₹65.79
Bio-wash     ₹10 /kg   5% loss    →   ₹10.53
Compacting   ₹10 /kg   0% loss    →   ₹10.00
                                      -------
                                     ₹451.81 /kg
```

Check it the long way: buy 96.8 kg of yarn at ₹320, pay knitting on 96.8 kg,
dyeing on the 95.83 kg that survives it, bio-wash on 92.00, compacting on
87.40 — ₹39,488 for 87.40 kg of cloth, which is ₹451.81/kg. The build-up has
to agree with the cheque book, and it does.

**Do not also put the loss in the wastage field.** A merchant who plans "88 kg
of fabric, take 10% more yarn" is describing the same loss the components
already carry. `Wastage %` on the line is cutting loss — cloth spoiled on the
table — and nothing else. Counting the process loss in both places prices the
order about 10% over.

The line cost is then:

```
gross g/pc = consumption g/pc × (1 + wastage %)
kg         = gross g/pc × production_qty × applies-to % ÷ 1000
cost       = kg × build-up rate
```

`Applies to %` covers the case where only some pieces carry a fabric — a
contrast hood lining on half the range.

A mill that quotes one finished price instead of a build-up: switch the line
to **One rate**.

---

## Trims, job work, CMT, other costs

**Trims** are per piece: quantity per garment, unit, rate, wastage. A trim on
only some sizes uses `applies to %`.

**Job work** is ₹ per piece, per process, per vendor — and it comes with two
things a flat rate misses:

- `applies to %` — only the front panel is printed, so only 40% of the pieces
  go out;
- `vendor loss %` — pieces damaged at the vendor that you still pay for. The
  line rounds up to whole garments, because that is what gets sent.

**CMT** is costed four ways, chosen per operation:

| Basis | Use it for |
| --- | --- |
| ₹ per piece | cutting, ironing, checking, packing |
| SAM × ₹ per minute | sewing |
| ₹ for the order | a one-off setup |
| % of the cost so far | a factory load that scales with the order |

Sewing on SAM asks for the **efficiency** as well, and that matters: a garment
with 16 SAM sewn at 65% efficiency uses 24.6 real minutes, not 16. Costing it
at 16 understates sewing by more than a third.

**Other costs** — sampling, lab test, documentation, transportation,
commission — take a lump sum for the order, a per-piece amount, a percentage
of cost, or a percentage of revenue.

Percentage lines are worked out after everything else, so they never depend on
the order the lines were typed in.

---

## Rate memory — why the second order is quick

Every rate that is saved is remembered against the context it was used in:
the buyer, the style, the fabric, the colour, the vendor, the component. When
a new sheet is built, the most specific memory is offered with its provenance
attached:

> **₹186** · dyeing, PINK — used on HR-014, three weeks ago

Click it to accept, or type over it. Typing over it teaches the next order.

Each rate is stored at **two scopes**: bound to the colour, and unbound. That
is what lets yarn and knitting carry to the next colour while dyeing stays
colour-specific — and when there is no colour-specific dyeing rate, the
unbound one is offered as a starting point, clearly labelled as such.

The whole library is on **Rate library**, with the history of every change:
who changed it, on which order, and what it was before. That screen answers
"why is this order dearer than the last one".

A rate can also be **forgotten** there, by anyone holding `rates.delete` —
Administrator, Management and **Costing & Commercial** as standard, that last
one because owning the library means being able to tidy it. The library fills itself from real
work, so it collects mistakes too: a rate typed against the wrong vendor, a
starting point nobody will ever use. Forgetting one changes nothing that has
already been costed, because every sheet keeps the figure it was saved with;
it only stops the number being offered on the next one. The rate's history of
changes goes with it, which is why the audit entry records what the rate was,
where it applied and how often it had been used.

### Starting points, and how to tell them apart

Seeding adds about a dozen **starting points** — a cutting rate, a sewing rate
per minute, a figure for sampling and lab tests. They exist so the very first
cost sheet has a shape to argue with instead of a page of zeroes. **Nobody has
quoted them.**

They are marked wherever they appear, in amber:

- the **Rate library** carries a banner and a "starting point" badge on each
  one, and shows *never used · shipped with the app* instead of a date;
- the **proposal** shown before a sheet exists counts them and says so;
- inside the **cost sheet**, a field still carrying one reads
  *"A starting point — replace with your real rate"* under the number.

The marker clears when somebody types a **different** number — not when a
sheet merely carries the default along. Accepting a placeholder unchanged does
not make it a quote, and clearing the flag then would hide the warning at the
one moment it is worth having. For the same reason, a buyer-specific memory
created from a shipped default inherits the marker, so the number cannot
quietly launder itself into looking quoted by being copied.

Replace them with your own rates before any sheet goes to a buyer. Editing one
in the Rate library, or simply typing over it on a cost sheet, is enough.

Starting a sheet on an order that has never been costed proposes:

- the fabric it is actually being cut from, at the piece weight cutting logged;
- one job-work line per outsourced step **in that order's own route**, with
  the vendor it actually uses;
- the CMT operations and other costs the factory normally has;
- every rate the library can match.

---

## Plan against actual

**Plan vs actual** on any sheet compares what was costed with what has
happened:

- fabric — the kilograms genuinely issued from the store, valued at the
  **receipt rate** where one was entered, falling back to the planned rate
  (the screen says which, per line);
- job work — the pieces actually sent out, at the sheet's rate;
- trims and CMT — the planned per-piece rates against real production;
- revenue — what has actually shipped.

Putting the rate on the fabric receipt is what makes this true rather than
approximate. Until then it is the plan measuring itself.

---

## Versions and approval

A sheet has versions. **New version** copies the current one and makes the
copy live; the old one is kept exactly as it was, so an approved quotation
survives being revised. Any version can be made the live one again.

Draft → Send for approval → Approved. Submitting notifies management; the
decision notifies whoever submitted it. An approved sheet is read-only unless
you can approve, and a locked one always is.

---

## Who sees what

Costing is permission-controlled block by block, and enforced on the server:

| Permission | Controls |
| --- | --- |
| `costing.view` | the module at all |
| `costing.fabric.view` / `.edit` | the fabric block |
| `costing.trims.view` / `.edit` | trims |
| `costing.jobwork.view` / `.edit` | job work and vendor rates |
| `costing.cmt.view` / `.edit` | CMT |
| `costing.overheads.view` / `.edit` | other costs |
| `costing.total_cost.view` | the garment cost total |
| `costing.selling_price.view` / `.edit` | the buyer's price |
| `costing.margin.view` | margin |
| `costing.approve` | approving a sheet |

A block you cannot see is not sent to your browser at all. Someone who may
edit trims but not job work cannot blank the job-work lines by omitting them
from a save, either — the server keeps what it does not let you touch.
