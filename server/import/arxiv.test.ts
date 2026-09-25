import { describe, expect, it } from "vitest";
import { normalizeInput } from "./importer";

describe("arXiv links", () => {
  it.each([
    ["https://arxiv.org/abs/2301.00001", "https://arxiv.org/pdf/2301.00001"],
    ["https://arxiv.org/abs/2301.00001v3", "https://arxiv.org/pdf/2301.00001v3"],
    ["http://arxiv.org/pdf/2301.00001", "https://arxiv.org/pdf/2301.00001"],
    ["https://arxiv.org/pdf/2301.00001v2.pdf", "https://arxiv.org/pdf/2301.00001v2"],
    ["https://www.arxiv.org/abs/1706.03762", "https://arxiv.org/pdf/1706.03762"],
    ["https://export.arxiv.org/abs/2106.09685v2", "https://arxiv.org/pdf/2106.09685v2"],
    ["https://arxiv.org/html/2403.12345v1", "https://arxiv.org/pdf/2403.12345v1"],
    ["https://arxiv.org/abs/hep-th/9901001", "https://arxiv.org/pdf/hep-th/9901001"],
    ["https://arxiv.org/abs/math.GT/0309136v1", "https://arxiv.org/pdf/math.GT/0309136v1"],
    ["arXiv:2301.00001", "https://arxiv.org/pdf/2301.00001"],
    ["arxiv 2301.00001v4", "https://arxiv.org/pdf/2301.00001v4"],
    ["2301.00001", "https://arxiv.org/pdf/2301.00001"],
    ["arxiv.org/abs/2301.00001", "https://arxiv.org/pdf/2301.00001"],
  ])("%s resolves to %s", (input, expected) => {
    const { url, arxiv } = normalizeInput(input);
    expect(url.toString()).toBe(expected);
    expect(arxiv).not.toBeNull();
  });

  it("leaves other links alone", () => {
    const { url, arxiv } = normalizeInput("https://example.org/papers/download?id=42");
    expect(url.toString()).toBe("https://example.org/papers/download?id=42");
    expect(arxiv).toBeNull();
  });

  it("does not treat arXiv listing pages as papers", () => {
    expect(normalizeInput("https://arxiv.org/list/cs.CL/recent").arxiv).toBeNull();
  });
});
