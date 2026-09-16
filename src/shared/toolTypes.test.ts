import { describe, expect, it } from "vitest";
import { stripScreenshot, takeScreenshot } from "./toolTypes";

describe("screenshot 附件旁路", () => {
  it("带 screenshot 字段的结果:取出附件,且要求 bytes 是 Uint8Array", () => {
    const attachment = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg", w: 10, h: 5 };
    const result = { url: "https://x", marks: [], screenshot: attachment };
    expect(takeScreenshot(result)).toEqual(attachment);
    expect(takeScreenshot(result)).not.toBe(result);
  });

  it("无 screenshot / 形状不对:返回 null(工具结果不受影响)", () => {
    expect(takeScreenshot({ url: "x" })).toBeNull();
    expect(takeScreenshot({ screenshot: { noBytes: true } })).toBeNull();
    expect(takeScreenshot(null)).toBeNull();
    expect(takeScreenshot("text")).toBeNull();
  });

  it("stripScreenshot 只剥 screenshot 字段,其余原样保留", () => {
    const result = { url: "https://x", marks: [{ n: 1 }], screenshot: { bytes: new Uint8Array() } };
    const stripped = stripScreenshot(result);
    expect("screenshot" in stripped).toBe(false);
    expect(stripped).toEqual({ url: "https://x", marks: [{ n: 1 }] });
  });

  it("无 screenshot 的结果原样返回", () => {
    const result = { url: "x" };
    expect(stripScreenshot(result)).toBe(result);
  });
});
