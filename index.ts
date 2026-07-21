/**
 * pi-jira extension entrypoint.
 *
 * Keep this file thin. Jira behavior lives in `src/` modules so the reloadable
 * entrypoint stays easy to audit, matching the maintenance style used by the
 * larger local Pi extensions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJiraTools } from "./src/tools.js";

/** Register all Jira tools with the Pi runtime. */
export default function jiraExtension(pi: ExtensionAPI) {
	registerJiraTools(pi);
}
