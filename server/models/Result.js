import mongoose from 'mongoose';

/**
 * ONE half of a market's daily draw.
 *
 * The operator declares the market twice per day:
 *   - at open time:  number (single digit) + pana (3-digit panel)
 *   - at close time: number (single digit) + pana (3-digit panel)
 *
 * The jodi is NEVER typed in - it is derived once both halves exist:
 *   jodi = last digit of open pana + last digit of close pana
 *
 * Display rules, matching how matka results are published:
 *   - open session only  -> the open number on its own, e.g. "257-7"
 *   - both sessions in   -> "257-369-79"  (open pana - close pana - jodi)
 *   - close only         -> "369-9"       (no jodi yet, open is missing)
 *
 * The unique index on (market, date, session) means re-declaring the same
 * half updates it rather than duplicating, so a typo is fixed by re-saving.
 */
const resultSchema = new mongoose.Schema(
  {
    market: { type: mongoose.Schema.Types.ObjectId, ref: 'Market', required: true, index: true },

    // Draw date in YYYY-MM-DD (local to the operator, not UTC).
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    /** Which half of the draw this row holds. */
    session: { type: String, enum: ['open', 'close'], required: true },

    /** The single drawn digit for this half, e.g. "7". */
    number: { type: String, required: true, trim: true, match: /^\d{1,2}$/ },

    /** The 3-digit panel/panna for this half, e.g. "257". */
    pana: { type: String, required: true, trim: true, match: /^\d{3}$/ },

    /** Last digit of `pana` - the ank for this half. */
    ank: { type: Number, required: true },

    /**
     * Cached "257-369-79" style string for the public page, plus the fields
     * it was built from. Recomputed by the route on every save, because
     * saving the close half changes the open half's display too.
     */
    display: { type: String, required: true },
    jodi: { type: String, default: null },
    /** True once both halves exist, i.e. the jodi is real. */
    jodiComplete: { type: Boolean, default: false },

    note: { type: String, default: '', maxlength: 300 },
    declaredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

resultSchema.index({ market: 1, date: 1, session: 1 }, { unique: true });

/** Ank of a panna = digit-SUM mod 10 ("269" -> 7), never its last digit
 *  ("9") - matches liveBoard.panaAnk, chartHistory.ankOf, fakeChart.ankOf. */
function ankOf(pana) {
  const s = String(pana ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  let sum = 0;
  for (const ch of s) sum += Number(ch);
  return sum % 10;
}

/**
 * Build the public display string from the open and close halves.
 *
 * Format follows the live site, e.g. "190-08-369" and "170-82-660":
 *
 *   OPEN ONLY   -> "<openPana>-<number>"          e.g. "127-0", "257-7"
 *   BOTH HALVES -> "<openPana>-<jodi>-<closePana>" e.g. "190-08-369"
 *
 * So the JODI SITS IN THE MIDDLE, not at the end, and the close pana is last.
 * The jodi is zero-padded to two digits, which is why the site shows "08".
 *
 * @param {object|null} openRow   { number, pana }
 * @param {object|null} closeRow  { number, pana }
 *
 * Returns { display, jodi, jodiComplete, ank }.
 *
 * NOTE: Mongoose `pre('validate')` hooks do NOT run on update operations
 * (findOneAndUpdate / updateOne), so the declare-result route calls this
 * exported helper directly. Keep the logic in one place.
 */
export function buildDisplay(openRow, closeRow) {
  const oPana = openRow?.pana ? String(openRow.pana).trim() : '';
  const oNum = openRow?.number ? String(openRow.number).trim() : '';
  const cPana = closeRow?.pana ? String(closeRow.pana).trim() : '';
  const cNum = closeRow?.number ? String(closeRow.number).trim() : '';

  // Jodi = open number + close number, always two digits ("7" + "2" -> "72",
  // "0" + "8" -> "08"). Only computable once both halves are declared.
  const jodi = oNum && cNum ? oNum.padStart(1, '0') + cNum.padStart(1, '0') : null;
  const jodiComplete = Boolean(jodi);

  let display;
  if (oPana && cPana) {
    // openPana - jodi - closePana, matching the live site's ordering.
    display = jodiComplete ? `${oPana}-${jodi}-${cPana}` : `${oPana}-${cPana}`;
  } else if (oPana) {
    // Open only: open panna + its single digit, e.g. "127-0".
    display = oNum ? `${oPana}-${oNum}` : oPana;
  } else if (cPana) {
    // Close only (open not declared yet): show the close panna + number.
    display = cNum ? `${cPana}-${cNum}` : cPana;
  } else {
    return { error: 'A number and panna are required' };
  }

  // The headline ank is the close ank when we have it, else the open ank.
  const ank = cNum ? Number(cNum.slice(-1)) : oNum ? Number(oNum.slice(-1)) : null;

  return { display, jodi, jodiComplete, ank };
}

resultSchema.pre('validate', function (next) {
  this.ank = Number(ankOf(this.pana));
  next();
});

export const Result = mongoose.model('Result', resultSchema);
export { ankOf };
