/** Prepare the original public Note examples from pinned responses, offline. */
import { composePlan } from "../../packages/core/compose.ts";
import { fixtureFetch, loadCatalog, resolveContract } from "../../scripts/check-substack-contracts.ts";

const output = process.argv[2];
if (!output) throw Error("Usage: bun extension/scripts/prepare_text_preview_cases.ts <cases.json>");
const catalog = await loadCatalog();
const cases = [];
for (const id of ["347044458", "348712218"]) {
  const contract = catalog.cases.find(value => value.id === id)!;
  const resolved = await resolveContract(contract, await fixtureFetch());
  cases.push({ id, plan: composePlan(resolved.sources, { ...resolved.policy, quoteDepth: "full" }) });
}
await Bun.write(output, JSON.stringify(cases, null, 2) + "\n");
