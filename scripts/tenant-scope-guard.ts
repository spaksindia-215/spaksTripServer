import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

// Static guard: every Mongoose query in a tenant-facing controller must be
// scoped to the authenticated caller's own data. This is a whitelabel SaaS —
// an agent (or customer) controller that forgets the scope key is a
// cross-tenant data leak, not just a logic bug. There's no framework-level
// enforcement of that today (no repository layer, no ORM-level tenant
// middleware), so this catches the "forgot to filter at all" class of bug at
// commit/CI time instead of in production.
//
// This is deliberately a shallow check, not a type-level proof of
// correctness: it verifies the scope key's *name* appears in the call's own
// source text (covering both `{ ownerId }` filter objects and
// `findById(ownerId)`-style positional lookups where the id itself IS the
// tenant key). It cannot verify the value is actually the request's own
// ownerId rather than some other ObjectId that happens to be a same-named
// variable — that requires real data-flow analysis, out of scope here.
//
// Escape hatch: a call site that's genuinely safe without the key in its own
// text (e.g. `BookingModel.findById(id)` right after a transaction already
// proved `id` belongs to this ownerId) gets a `// tenant-scope-ok: <reason>`
// comment on the same line or the line above.
//
// Run: npm run guard:tenant-scope (from server/)

const TARGETS: Array<{ file: string; scopeKeys: string[] }> = [
  { file: "src/controllers/agent.controller.ts", scopeKeys: ["ownerId"] },
  { file: "src/controllers/customer.controller.ts", scopeKeys: ["ownerId", "customer"] },
];

const QUERY_METHODS = new Set([
  "find",
  "findOne",
  "findById",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "findOneAndDelete",
  "findByIdAndDelete",
  "findOneAndReplace",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "countDocuments",
  "aggregate",
]);

const ESCAPE_HATCH = /tenant-scope-ok\s*:/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function checkFile(root: string, file: string, scopeKeys: string[]): Violation[] {
  const fullPath = path.join(root, file);
  const source = fs.readFileSync(fullPath, "utf8");
  const sourceFile = ts.createSourceFile(fullPath, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (QUERY_METHODS.has(methodName)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const callText = node.getText();
        // Escape-hatch comments may be multi-line explanations — scan the call's
        // own line plus a few lines above for the marker, not just the one
        // immediately adjacent line.
        const windowStart = Math.max(0, line - 5);
        const nearbyText = lines.slice(windowStart, line + 1).join("\n");
        const hasEscapeHatch = ESCAPE_HATCH.test(nearbyText);
        const hasScopeKey = scopeKeys.some((key) => callText.includes(key));
        if (!hasScopeKey && !hasEscapeHatch) {
          violations.push({
            file,
            line: line + 1,
            text: callText.split("\n")[0].slice(0, 100),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function main(): void {
  const root = path.join(__dirname, "..");
  let violations: Violation[] = [];
  for (const target of TARGETS) {
    violations = violations.concat(checkFile(root, target.file, target.scopeKeys));
  }

  if (violations.length === 0) {
    console.log(`✓ tenant-scope-guard: all ${TARGETS.length} target file(s) clean.`);
    process.exit(0);
  }

  console.error(
    `✗ tenant-scope-guard: ${violations.length} unscoped quer${violations.length === 1 ? "y" : "ies"} found:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    "\nEvery Mongo query in these files must filter by the caller's own tenant " +
      "key, or carry a `// tenant-scope-ok: <reason>` comment explaining why not.",
  );
  process.exit(1);
}

main();
