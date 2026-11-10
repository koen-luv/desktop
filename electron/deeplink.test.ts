import { describe, expect, it } from "vitest";
import { findDeeplinkArg, parseDeeplink } from "./deeplink";

describe("parseDeeplink", () => {
  it("accepts password reset links with a well-formed token only", () => {
    const token = `lrst_${"a".repeat(43)}`;
    expect(parseDeeplink(`neritium://reset-password?id=${token}`)).toEqual({
      type: "reset-password",
      id: token,
    });
    expect(parseDeeplink(`neritium://reset-password?id=${token}x`)).toBeNull();
    expect(parseDeeplink("neritium://reset-password?id=lrst_short")).toBeNull();
    expect(
      parseDeeplink(`neritium://reset-password?id=lmod_${"a".repeat(43)}`),
    ).toBeNull();
  });

  it("accepts real share targets", () => {
    expect(parseDeeplink("neritium://artist?id=UCGtGpOIGHfRu1KYL9pi-mNQ")).toEqual({
      type: "artist",
      id: "UCGtGpOIGHfRu1KYL9pi-mNQ",
    });
    expect(parseDeeplink("neritium://album?id=MPREb_xCxkOKReFZv")).toEqual({
      type: "album",
      id: "MPREb_xCxkOKReFZv",
    });
    expect(
      parseDeeplink("neritium://playlist?id=VLPLD8jNKEyHYB2DHh5vXSI4USLFo29vzUYl"),
    ).toEqual({ type: "playlist", id: "VLPLD8jNKEyHYB2DHh5vXSI4USLFo29vzUYl" });
    expect(parseDeeplink("neritium://track?id=RGdkabupfPI")).toEqual({
      type: "track",
      id: "RGdkabupfPI",
    });
  });

  it("rejects smuggled urls", () => {
    expect(parseDeeplink("https://evil.com")).toBeNull();
    expect(parseDeeplink("javascript:alert(1)")).toBeNull();
    expect(parseDeeplink("neritium://artist?id=UCaaaaaaaaaaaaaaaaaaaaaa&x=1&y=2")).toEqual({
      type: "artist",
      id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      parseDeeplink("neritium://artist?id=UCaaaaaaaaaaaaaaaaaaaaaa&id=UCbbbbbbbbbbbbbbbbbbbbbb"),
    ).toBeNull();
    expect(parseDeeplink("neritium://artist")).toBeNull();
    expect(parseDeeplink("neritium://evil?id=RGdkabupfPI")).toBeNull();
    expect(parseDeeplink("neritium://track?id=RGdkabupfPIextra")).toBeNull();
    expect(parseDeeplink("neritium://artist?id=ABaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(parseDeeplink("neritium://artist?id=UCaaa/../../../../etc")).toBeNull();
    expect(parseDeeplink("not a url")).toBeNull();
  });

  it("accepts legacy liner:// links from before the rebrand", () => {
    expect(parseDeeplink("liner://track?id=RGdkabupfPI")).toEqual({
      type: "track",
      id: "RGdkabupfPI",
    });
    expect(parseDeeplink("LINER://artist?id=UCGtGpOIGHfRu1KYL9pi-mNQ")).toEqual({
      type: "artist",
      id: "UCGtGpOIGHfRu1KYL9pi-mNQ",
    });
    const token = `lrst_${"a".repeat(43)}`;
    expect(parseDeeplink(`liner://reset-password?id=${token}`)).toEqual({
      type: "reset-password",
      id: token,
    });
    // still strict about everything after the scheme
    expect(parseDeeplink("liner://evil?id=RGdkabupfPI")).toBeNull();
    expect(parseDeeplink("liner://track?id=RGdkabupfPIextra")).toBeNull();
    expect(parseDeeplink("linerx://track?id=RGdkabupfPI")).toBeNull();
  });

  it("finds the deeplink arg anywhere in argv", () => {
    expect(
      findDeeplinkArg(["/usr/bin/neritium", "neritium://track?id=RGdkabupfPI"]),
    ).toBe("neritium://track?id=RGdkabupfPI");
    expect(
      findDeeplinkArg(["/usr/bin/neritium", "liner://track?id=RGdkabupfPI"]),
    ).toBe("liner://track?id=RGdkabupfPI");
    expect(findDeeplinkArg(["/usr/bin/neritium", "--no-sandbox"])).toBeUndefined();
  });
});
