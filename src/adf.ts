/**
 * Minimal Atlassian Document Format conversion.
 *
 * This is deliberately best-effort: enough to make descriptions/comments useful
 * in agent context and exports, not a complete rich-text renderer or Markdown
 * parser.
 */
type AdfNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	content?: unknown[];
};

type TextAdfNode = {
	type: "text";
	text: string;
	marks?: Array<{ type: "link"; attrs: { href: string } }>;
};

type HardBreakAdfNode = { type: "hardBreak" };

type InlineAdfNode = TextAdfNode | HardBreakAdfNode;

const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/g;

function asNode(value: unknown): AdfNode | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as AdfNode) : undefined;
}

function attrText(node: AdfNode, ...names: string[]): string {
	for (const name of names) {
		const value = node.attrs?.[name];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
}

function renderChildren(content: unknown[] | undefined, orderedStart = 1, separator = ""): string {
	return (content ?? [])
		.map((item) => renderAdfNode(item, orderedStart))
		.filter(Boolean)
		.join(separator);
}

function prefixLines(text: string, firstPrefix: string, nextPrefix: string): string {
	return text
		.split("\n")
		.map((line, index) => `${index === 0 ? firstPrefix : nextPrefix}${line}`)
		.join("\n");
}

function renderAdfNode(value: unknown, orderedStart = 1): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return renderChildren(value, orderedStart);
	const node = asNode(value);
	if (!node) return String(value);

	switch (node.type) {
		case "doc":
			return renderChildren(node.content, orderedStart, "\n\n");
		case "paragraph":
		case "heading":
		case "codeBlock":
			return renderChildren(node.content, orderedStart);
		case "text":
			return node.text ?? "";
		case "hardBreak":
			return "\n";
		case "mention":
			return attrText(node, "text", "displayName", "id");
		case "inlineCard":
		case "blockCard":
			return attrText(node, "url");
		case "blockquote":
			return renderChildren(node.content, orderedStart)
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
		case "bulletList":
			return (node.content ?? [])
				.map((item) => renderAdfNode(item, orderedStart).trim())
				.filter(Boolean)
				.map((item) => prefixLines(item, "- ", "  "))
				.join("\n");
		case "orderedList": {
			const start = typeof node.attrs?.order === "number" ? node.attrs.order : orderedStart;
			return (node.content ?? [])
				.map((item, index) => ({ index: start + index, text: renderAdfNode(item, start + index).trim() }))
				.filter((item) => Boolean(item.text))
				.map((item) => prefixLines(item.text, `${item.index}. `, "   "))
				.join("\n");
		}
		case "listItem":
			return renderChildren(node.content, orderedStart, "\n");
		case "rule":
			return "---";
		case "mediaSingle":
		case "mediaGroup":
			return renderChildren(node.content, orderedStart, "\n");
		case "media":
			return attrText(node, "alt", "id") || "[media]";
		default:
			return renderChildren(node.content, orderedStart);
	}
}

/** Convert Jira ADF-ish values into compact plain text for reads and exports. */
export function adfToText(value: unknown): string {
	return renderAdfNode(value)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function appendText(nodes: InlineAdfNode[], text: string): void {
	if (text.length > 0) nodes.push({ type: "text", text });
}

function splitTrailingUrlPunctuation(rawUrl: string): { url: string; trailing: string } {
	let url = rawUrl;
	let trailing = "";
	while (/[.,;:!?\])}]/.test(url.at(-1) ?? "")) {
		trailing = `${url.at(-1)}${trailing}`;
		url = url.slice(0, -1);
	}
	return { url, trailing };
}

function linkNode(text: string, href: string): TextAdfNode {
	return { type: "text", text, marks: [{ type: "link", attrs: { href } }] };
}

function inlineTextToAdf(text: string): InlineAdfNode[] {
	const nodes: InlineAdfNode[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(LINK_PATTERN)) {
		const index = match.index ?? 0;
		appendText(nodes, text.slice(lastIndex, index));
		if (match[1] && match[2]) {
			nodes.push(linkNode(match[1], match[2]));
		} else if (match[3]) {
			const { url, trailing } = splitTrailingUrlPunctuation(match[3]);
			nodes.push(linkNode(url, url));
			appendText(nodes, trailing);
		}
		lastIndex = index + match[0].length;
	}
	appendText(nodes, text.slice(lastIndex));
	return nodes;
}

/** Convert comment text into minimal ADF, linkifying Markdown-style links and bare URLs. */
export function textToAdf(text: string) {
	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n{2,}/);
	return {
		version: 1,
		type: "doc",
		content: paragraphs.map((paragraph) => {
			const parts = paragraph.split("\n");
			const content: InlineAdfNode[] = [];
			parts.forEach((part, index) => {
				content.push(...inlineTextToAdf(part));
				if (index < parts.length - 1) content.push({ type: "hardBreak" });
			});
			return { type: "paragraph", content };
		}),
	};
}
