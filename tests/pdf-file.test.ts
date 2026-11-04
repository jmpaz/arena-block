import { expect, test } from "bun:test";
import { pdfFilePlan, publicationPayload, publicationPayloadForMedia } from "../packages/core/capture.ts";
import { verifyPublication } from "../packages/core/verification.ts";
import { blockPlanSchema } from "../packages/core/types.ts";
import { browserCanPublish } from "../extension/src/browser-save.ts";

const source = "https://dl.acm.org/doi/10.1145/320435.320594";
const file = { sha256: "a".repeat(64), byteCount: 12345 };
const make = () => pdfFilePlan({ sourceUrl: source, originalUrl: "https://example.com/download", title: "Edited paper", file });

test("retained PDF plans identify bytes independently of source and original URL", () => {
  const plan = make();
  expect(blockPlanSchema.parse(plan)).toEqual(plan);
  expect(plan.block).toMatchObject({ kind: "url", canonicalSource: source, contentUrl: "https://example.com/download", contentType: "application/pdf", pdfFile: file });
  expect(pdfFilePlan({ sourceUrl: source, title: "Edited paper", file }).block.contentUrl).toBeUndefined();
  expect(pdfFilePlan({ sourceUrl: source, title: "Edited paper", file: { ...file, sha256: "b".repeat(64) } }).hash).not.toBe(plan.hash);
  expect(browserCanPublish(plan)).toBe(false);
});

test("retained PDFs cannot fall back to ingesting their source page", () => {
  const plan = make();
  expect(() => publicationPayload(plan, "", undefined, [])).toThrow("Upload");
  expect(() => publicationPayloadForMedia(plan, undefined, undefined, [])).toThrow();
  expect(publicationPayloadForMedia(plan, "https://attachments.example/paper.pdf", undefined, [7])).toMatchObject({ value: "https://attachments.example/paper.pdf", original_source_url: source, title: "Edited paper" });
  for (const sourceUrl of ["file:///tmp/paper.pdf", "https://user:password@example.com/"])
    expect(() => pdfFilePlan({ sourceUrl, title: "Paper", file })).toThrow();
  expect(() => pdfFilePlan({ sourceUrl: source, title: "Paper", file: { ...file, byteCount: 50 * 1024 * 1024 + 1 } })).toThrow();
});

test("retained PDF verification checks type, source and byte count", () => {
  const plan = make();
  const block = { state: "available", type: "Attachment", title: "Edited paper", description: null,
    source: { url: source }, attachment: { content_type: "application/pdf", url: "https://attachments.are.na/paper.pdf", file_size: file.byteCount } };
  expect(() => verifyPublication(plan, block, block)).not.toThrow();
  for (const attachment of [{ ...block.attachment, file_size: 12 }, { ...block.attachment, file_size: undefined }, { ...block.attachment, content_type: "text/html" }])
    expect(() => verifyPublication(plan, { ...block, attachment }, block)).toThrow();
});
