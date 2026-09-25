import { describe, expect, it } from "vitest";
import sampleEn from "./__fixtures__/sample-paper.json";
import { buildContext, findSection } from "./context";
import { extractSelection } from "./extract";
import { locate, modelFromFixture, selectRange, type FixturePage } from "./testUtils";
import { CONTEXT_LIMITS } from "../../shared/config";

const pages = (sampleEn as FixturePage[]).map(modelFromFixture);
const [page1, page2] = [pages[0]!, pages[1]!];

describe("selection context", () => {
  it("includes nearby text before and after, bounded and without furniture", () => {
    const { kept } = extractSelection(page1, selectRange(page1, "Attention [1] addressed", "proceeds."));
    const context = buildContext(page1, kept);
    expect(context.before.endsWith("amount of information.")).toBe(true);
    expect(context.after.startsWith("Later work showed")).toBe(true);
    expect(context.before.length).toBeLessThanOrEqual(CONTEXT_LIMITS.beforeChars);
    expect(context.after.length).toBeLessThanOrEqual(CONTEXT_LIMITS.afterChars);
    expect(context.before).not.toContain("Passage sample document ·");
  });

  it("finds the enclosing numbered section heading", () => {
    const { kept } = extractSelection(page1, selectRange(page1, "Luong et al. [5] compared", "hardware."));
    expect(buildContext(page1, kept).section).toBe("3.1 Additive and Multiplicative Scoring");
  });

  it("continues context from the previous page when the selection starts a page", () => {
    const { kept } = extractSelection(page2, selectRange(page2, "dot product has variance", "saturates,"));
    const context = buildContext(page2, kept, { previous: page1 });
    expect(context.before).toContain("If the components of queries and keys");
    expect(context.before).not.toMatch(/\n1$/);
    expect(context.section).toBe("3.2 Scaled Dot-Product Attention");
  });

  it("returns null when no heading precedes the selection on the page", () => {
    const { index } = locate(page1, "Neural machine translation maps");
    expect(findSection(page1, index)).toBeNull();
  });
});
