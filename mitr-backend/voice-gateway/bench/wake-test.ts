import { WakeMatcher } from "../src/wake/matcher.js";
const configured = ["hi mitr","hey mitr","hi mitra","hey mitra","hi reca","hey reca","hi rekha","hey rekha","hi r e k a","hey r e k a","hi reka","hey reka","hi esp","hey esp","hi e s p"];
const observed = ["हाय Rekha","हाय रे का","हाय रका","हाय रे का।","हाय रेका।","हाय रेखा","hey mater","हाय मित्र","हाय mitra","hi मित्र","Hay Rekha"];
for (const t of observed) {
  const m = new WakeMatcher(configured);
  console.log(`${m.feed(t) ? "MATCH " : "miss  "} "${t}"`);
}
