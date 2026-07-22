import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJiraTools } from "../src/tools.js";

describe("Jira tool registration", () => {
	test("registers bulk, attachment, and issue lifecycle tools", () => {
		const names: string[] = [];
		const pi = {
			registerTool(tool: { name: string }) {
				names.push(tool.name);
			},
		} as unknown as ExtensionAPI;

		registerJiraTools(pi);
		expect(names).toContain("jira_get_issues");
		expect(names).toContain("jira_upload_attachments");
		expect(names).toContain("jira_download_attachments");
		expect(names).toContain("jira_delete_issue");
		expect(names).not.toContain("jira_download_attachment");
		expect(names).not.toContain("jira_export_issue");
		expect(new Set(names).size).toBe(names.length);
	});
});
