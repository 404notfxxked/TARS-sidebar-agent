// web_fetch_image 纯校验层单测:只钉不碰网络与 IndexedDB 的判定契约
// (参数形态 / 协议 / mime / 大小 / 成功回执文案)。fetch→解码→落库链路
// 归 e2e(verify-web-search 场景 K)—— SW 的 createImageBitmap 与 IDB
// 在 node 侧没有等价物,把可单测的部分拆成纯函数正是为了在此钉死。

import { describe, expect, it } from "vitest";
import {
  assertImageBytes,
  assertImageContentType,
  parseImageUrl,
  storedImageNotice,
} from "./fetchImage";

/** 捕获抛错文案(空串 = 没抛,断言自然失败) */
const errOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
};

describe("parseImageUrl(参数形态与协议)", () => {
  it("合法 http/https 通过,首尾空白容忍", () => {
    expect(parseImageUrl({ url: "https://img.test/pic.png" })).toBe(
      "https://img.test/pic.png",
    );
    expect(parseImageUrl({ url: "  http://10.0.0.5/a.png \n" })).toBe(
      "http://10.0.0.5/a.png",
    );
  });

  it("缺参 / 非字符串 / 空串 → 可行动错误", () => {
    for (const args of [
      null,
      undefined,
      {},
      { url: 42 },
      { url: "" },
      { url: "   " },
    ]) {
      expect(errOf(() => parseImageUrl(args)), JSON.stringify(args)).toMatch(
        /url/,
      );
    }
  });

  it("非 http(s) 协议拒(data:/chrome:/ftp:)", () => {
    for (const u of [
      "ftp://img.test/a.png",
      "data:image/png;base64,AAAA",
      "chrome://version",
    ]) {
      expect(errOf(() => parseImageUrl({ url: u })), u).toMatch(/http\/https/);
    }
  });

  it("无法解析的 URL 拒", () => {
    expect(errOf(() => parseImageUrl({ url: "not a url" }))).toMatch(/url/i);
  });
});

describe("assertImageContentType(必须 image/*,取不到也拒)", () => {
  it("image/* 通过并归一为去参小写 mime", () => {
    expect(assertImageContentType("image/png")).toBe("image/png");
    expect(assertImageContentType("IMAGE/JPEG")).toBe("image/jpeg");
    expect(assertImageContentType("image/png; charset=binary")).toBe(
      "image/png",
    );
  });

  it("非 image/* 与缺失拒", () => {
    expect(errOf(() => assertImageContentType("text/html"))).toMatch(/image/i);
    expect(
      errOf(() => assertImageContentType("application/octet-stream")),
    ).toMatch(/image/i);
    expect(errOf(() => assertImageContentType(""))).toMatch(/image/i);
    expect(
      errOf(() => assertImageContentType(null as unknown as string)),
    ).toMatch(/image/i);
  });
});

describe("assertImageBytes(4MB 上限)", () => {
  it("上限内通过,超限拒并带上限字样", () => {
    expect(() => assertImageBytes(1024)).not.toThrow();
    expect(() => assertImageBytes(4_000_000)).not.toThrow();
    expect(errOf(() => assertImageBytes(4_000_001))).toMatch(/4 MB/);
  });

  it("非有限数值拒", () => {
    expect(errOf(() => assertImageBytes(Number.NaN))).toMatch(/大小/);
  });
});

describe("storedImageNotice(成功回执契约)", () => {
  it("首行 JSON(stored/id/mime/w/h/source)+ 尾随引用指引", () => {
    const s = storedImageNotice({
      id: "img-1",
      mime: "image/png",
      w: 1,
      h: 1,
      url: "https://img.test/pic.png",
    });
    const [jsonLine, ...rest] = s.split("\n");
    expect(JSON.parse(jsonLine)).toEqual({
      stored: true,
      id: "img-1",
      mime: "image/png",
      w: 1,
      h: 1,
      source: "https://img.test/pic.png",
    });
    expect(rest.join("\n")).toMatch(
      /Reference it in your answer as !\[alt\]\(tars-img:img-1\)/,
    );
  });
});
