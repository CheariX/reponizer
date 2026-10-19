import { runScheduledBulkCommand } from "./lib/bulkCommand";
import { pullRepo } from "./lib/ops";

/** Pull All on a daily `interval` (opt-in: the command is disabled by default). */
export default async function Command() {
  await runScheduledBulkCommand("Pulling", pullRepo);
}
