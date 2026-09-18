// Relative view-rule tokens: "@dayofmonth" and "@today" stand in for a literal
// in a view rule and resolve at query time, so a day-of-month rotation (today's
// attribute of God, today's Baillie prayers) is one saved view rather than a
// value someone retypes every morning.
//  - view-where.ts: the pure resolver + token helpers
//  - views.ts buildWhereSql: the token is resolved into the SQL parameters
// Pure: no DB, no browser.
//   npx tsx scripts/verify-view-tokens.mts
import { PgDialect } from "drizzle-orm/pg-core";
import {
  DAY_OF_MONTH_TOKEN,
  TODAY_TOKEN,
  isRelativeToken,
  relativeTokenLabel,
  resolveRelativeValue,
} from "../src/lib/view-where";
import { buildWhereSql } from "../src/lib/views";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- the pure resolver ------------------------------------------------------
const ref = { y: 2026, m: 9, d: 17 };
check(
  "@dayofmonth resolves to the date number",
  resolveRelativeValue(DAY_OF_MONTH_TOKEN, ref) === "17"
);
check("@today resolves to the calendar day", resolveRelativeValue(TODAY_TOKEN, ref) === "2026-09-17");
check(
  "@today zero-pads single digits",
  resolveRelativeValue(TODAY_TOKEN, { y: 2026, m: 3, d: 5 }) === "2026-03-05"
);
check("a literal passes through", resolveRelativeValue("17", ref) === "17");
check("an empty value passes through", resolveRelativeValue(undefined, ref) === undefined);
check(
  "isRelativeToken only matches the tokens",
  isRelativeToken(DAY_OF_MONTH_TOKEN) && isRelativeToken(TODAY_TOKEN) && !isRelativeToken("17")
);
check("tokens carry a human label", relativeTokenLabel(DAY_OF_MONTH_TOKEN) === "Today's date number");

// --- resolution reaches the SQL --------------------------------------------
// The rotation filter as a saved view stores it: a multi_select "days" property
// holding day numbers, matched against today.
const dialect = new PgDialect();
const today = String(new Date().getDate());

const tokenSql = buildWhereSql({
  combinator: "and",
  conditions: [{ subject: "property", key: "days", op: "eq", value: DAY_OF_MONTH_TOKEN }],
});
const tokenQuery = tokenSql ? dialect.sqlToQuery(tokenSql) : null;
const tokenParams = JSON.stringify(tokenQuery?.params ?? []);
check(
  "a @dayofmonth rule carries today's number into the query",
  tokenParams.includes(`"days":"${today}"`) || tokenParams.includes(`{\\"days\\":\\"${today}\\"}`),
  tokenParams.slice(0, 160)
);
check(
  "the token itself never reaches the query",
  !tokenParams.includes(DAY_OF_MONTH_TOKEN),
  tokenParams.slice(0, 160)
);

// A numeric comparison resolves too: "day is at least @dayofmonth" casts as a
// number rather than dropping the condition (Number("@dayofmonth") is NaN).
const numericSql = buildWhereSql({
  combinator: "and",
  conditions: [
    { subject: "property", key: "day", op: "gte", value: DAY_OF_MONTH_TOKEN, numeric: true },
  ],
});
const numericParams = JSON.stringify(numericSql ? dialect.sqlToQuery(numericSql).params : []);
check(
  "a numeric @dayofmonth rule survives the numeric cast",
  numericSql !== null && numericParams.includes(today),
  numericParams.slice(0, 160)
);

// A literal rule is untouched by any of this.
const literalSql = buildWhereSql({
  combinator: "and",
  conditions: [{ subject: "property", key: "days", op: "eq", value: "3" }],
});
const literalParams = JSON.stringify(literalSql ? dialect.sqlToQuery(literalSql).params : []);
check(
  "a literal rule is unchanged",
  literalParams.includes('"days":"3"') || literalParams.includes('{\\"days\\":\\"3\\"}'),
  literalParams.slice(0, 160)
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
