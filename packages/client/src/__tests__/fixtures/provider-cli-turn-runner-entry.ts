import { dirname } from "node:path";
import { runProviderCliTurnRunner } from "../../runtime/provider-cli/turn-runner.js";

const argv = process.argv.slice(2);
const planFlag = argv.indexOf("--plan");
const planPath = planFlag >= 0 ? argv[planFlag + 1] : undefined;

if (!planPath) {
  process.stderr.write("The test Provider CLI Turn runner requires --plan\n");
  process.exit(1);
}

// plan.json -> Session namespace -> Home namespace -> plans root. Production never
// accepts this derivation; its standalone runner uses the OS-account-global root.
const plansRoot = dirname(dirname(dirname(planPath)));
void runProviderCliTurnRunner(argv, { plansRoot }).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
