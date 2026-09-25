import { describe, expect, it } from "vitest";
import { placeCard } from "./placement";

const viewport = { left: 0, top: 1000, width: 1200, height: 800 };
const content = { width: 1200, height: 5000 };
const card = { width: 400, height: 220 };

describe("translation card placement", () => {
  it("prefers the space below the passage, aligned with it", () => {
    const result = placeCard({ anchor: { left: 300, top: 1100, width: 500, height: 60 }, viewport, card, content });
    expect(result.placement).toBe("below");
    expect(result.top).toBe(1100 + 60 + 10);
    expect(result.left).toBe(300);
  });

  it("goes above when there is no room below", () => {
    const result = placeCard({ anchor: { left: 300, top: 1650, width: 500, height: 60 }, viewport, card, content });
    expect(result.placement).toBe("above");
    expect(result.top + Math.min(card.height, result.maxHeight)).toBeLessThanOrEqual(1650 - 10);
  });

  it("uses the side margin for tall passages when there is room", () => {
    const result = placeCard({ anchor: { left: 200, top: 1050, width: 500, height: 700 }, viewport, card, content });
    expect(result.placement).toBe("right");
    expect(result.left).toBe(710);
    expect(result.top).toBeGreaterThanOrEqual(1012);
  });

  it("never lets the card leave the visible area horizontally", () => {
    const result = placeCard({ anchor: { left: 1000, top: 1100, width: 150, height: 20 }, viewport, card, content });
    expect(result.left + card.width).toBeLessThanOrEqual(viewport.left + viewport.width - 12);
  });

  it("limits the height and scrolls inside when neither side fits the whole card", () => {
    const narrow = { left: 0, top: 0, width: 700, height: 700 };
    const result = placeCard({
      anchor: { left: 50, top: 300, width: 600, height: 150 },
      viewport: narrow,
      card: { width: 400, height: 600 },
      content,
    });
    expect(["below", "above"]).toContain(result.placement);
    expect(result.maxHeight).toBeLessThan(600);
    expect(result.maxHeight).toBeGreaterThanOrEqual(150);
  });

  it("keeps the previous side when it still fits (no jumping while text streams in)", () => {
    const anchor = { left: 300, top: 1400, width: 500, height: 60 };
    const result = placeCard({ anchor, viewport, card: { width: 400, height: 200 }, content, previous: "above" });
    expect(result.placement).toBe("above");
  });

  it("covers only the lower part of the view as a last resort", () => {
    const small = { left: 0, top: 0, width: 500, height: 400 };
    const result = placeCard({ anchor: { left: 20, top: 5, width: 460, height: 390 }, viewport: small, card: { width: 400, height: 300 }, content });
    expect(result.placement).toBe("overlay");
    expect(result.top).toBeGreaterThan(100);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(400);
  });
});
