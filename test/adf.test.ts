import { describe, expect, test } from "bun:test";
import { adfToText, textToAdf } from "../src/adf.js";

describe("ADF conversion", () => {
	test("linkifies Markdown links without changing their label", () => {
		const adf = textToAdf("See [the issue](https://example.com/issues/42).");
		expect(adf.content[0]?.content).toContainEqual({
			type: "text",
			text: "the issue",
			marks: [{ type: "link", attrs: { href: "https://example.com/issues/42" } }],
		});
	});

	test("renders common block nodes as plain text", () => {
		const text = adfToText({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Summary" }] },
				{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }] }] },
			],
		});
		expect(text).toBe("Summary\n\n- Item");
	});
});
