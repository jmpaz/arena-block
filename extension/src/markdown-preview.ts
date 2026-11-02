import { Lexer, type Token, type Tokens } from "marked";
import { publicationFields } from "../../packages/core/capture.ts";
import type { BlockPlan } from "../../packages/core/types.ts";

// Parse Markdown into tokens, then create only these elements. Source HTML is
// literal text; previewing never creates embedded resources or executes HTML.
export function renderMarkdownPreview(container: HTMLElement, markdown: string, baseURL?: string): void {
  const doc = container.ownerDocument;
  const text = (parent: Node, value: string) => parent.appendChild(doc.createTextNode(value));
  const decode = (value: string) => value.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);?/g, entity => {
    const area = doc.createElement("textarea");
    // Only an individual character reference enters the inert decoder.
    area.innerHTML = entity;
    return area.value;
  });
  const href = (value: string, literal = false): string | undefined => {
    const decoded = literal ? value : decode(value);
    if (/[\u0000-\u0020\u007f]/.test(decoded)) return undefined;
    try {
      const url = new URL(decoded, baseURL);
      if (!["http:", "https:", "mailto:"].includes(url.protocol) || url.username || url.password) return undefined;
      return url.href;
    } catch { return undefined; }
  };
  const append = (parent: Node, tokens: Token[], depth = 0): void => {
    if (depth > 64) throw new Error("Preview nesting limit");
    for (const token of tokens) {
      const element = (tag: string, children?: Token[]) => {
        const node = doc.createElement(tag);
        parent.appendChild(node);
        if (children) append(node, children, depth + 1);
        return node;
      };
      switch (token.type) {
        case "space": text(parent, "\n"); break;
        case "escape": text(parent, decode((token as Tokens.Escape).text)); break;
        case "text": {
          const item = token as Tokens.Text;
          if (item.tokens) append(parent, item.tokens, depth + 1);
          else text(parent, decode(item.text));
          break;
        }
        case "paragraph": element("p", (token as Tokens.Paragraph).tokens); text(parent, "\n"); break;
        case "heading": element(`h${Math.min(6, Math.max(1, (token as Tokens.Heading).depth))}`, (token as Tokens.Heading).tokens); text(parent, "\n"); break;
        case "blockquote": element("blockquote", (token as Tokens.Blockquote).tokens); text(parent, "\n"); break;
        case "strong": element("strong", (token as Tokens.Strong).tokens); break;
        case "em": element("em", (token as Tokens.Em).tokens); break;
        case "del": element("del", (token as Tokens.Del).tokens); break;
        case "br": element("br"); text(parent, "\n"); break;
        case "hr": element("hr"); text(parent, "\n"); break;
        case "codespan": text(element("code"), (token as Tokens.Codespan).text); break;
        case "code": text(element("pre").appendChild(doc.createElement("code")), (token as Tokens.Code).text); text(parent, "\n"); break;
        case "html": text(parent, (token as Tokens.HTML).text); break;
        case "link": {
          const item = token as Tokens.Link;
          const destination = href(item.href, item.autolink);
          if (!destination) append(parent, item.tokens, depth + 1);
          else {
            const link = element("a") as HTMLAnchorElement;
            link.href = destination;
            link.target = "_blank";
            link.rel = "noreferrer noopener";
            if (item.title) link.title = decode(item.title);
            if (item.autolink) text(link, item.text);
            else append(link, item.tokens, depth + 1);
          }
          break;
        }
        case "image": {
          const item = token as Tokens.Image;
          // Media already has its own preview. Keep authored alt text here,
          // without issuing an image request from editable Markdown.
          append(parent, item.tokens, depth + 1);
          break;
        }
        case "list": {
          const item = token as Tokens.List;
          const list = element(item.ordered ? "ol" : "ul") as HTMLOListElement;
          if (item.ordered && typeof item.start === "number") list.start = item.start;
          for (const entry of item.items) {
            const li = doc.createElement("li"); list.appendChild(li);
            if (entry.task) text(li, entry.checked ? "☑ " : "☐ ");
            append(li, entry.tokens, depth + 1);
            text(list, "\n");
          }
          text(parent, "\n");
          break;
        }
        case "table": {
          const item = token as Tokens.Table, table = element("table");
          const row = (parent: HTMLElement, cells: Tokens.TableCell[], tag: "th" | "td") => {
            const tr = doc.createElement("tr"); parent.appendChild(tr);
            cells.forEach((cell, index) => {
              const td = doc.createElement(tag); tr.appendChild(td);
              const align = item.align[index];
              if (align === "left" || align === "right" || align === "center") td.style.textAlign = align;
              append(td, cell.tokens, depth + 1); text(tr, "\t");
            });
            text(parent, "\n");
          };
          const head = doc.createElement("thead"); table.appendChild(head); row(head, item.header, "th");
          const body = doc.createElement("tbody"); table.appendChild(body);
          for (const cells of item.rows) row(body, cells, "td");
          text(parent, "\n");
          break;
        }
        default: text(parent, token.raw);
      }
    }
  };
  const fragment = doc.createDocumentFragment();
  try { append(fragment, Lexer.lex(markdown, { gfm: true })); }
  catch { fragment.textContent = markdown; }
  container.textContent = "";
  container.appendChild(fragment);
}

export function markdownSummary(doc: Document, markdown: string): string {
  const container = doc.createElement("div");
  renderMarkdownPreview(container, markdown);
  return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** Use the actual publication fields, including descriptions on media blocks. */
export function renderBlockTextPreview(container: HTMLElement, plan: BlockPlan): void {
  const fields = publicationFields(plan);
  const markdown = [fields.content, fields.description].filter(value => typeof value === "string" && value).join("\n\n---\n\n");
  renderMarkdownPreview(container, markdown, plan.block.canonicalSource);
}
