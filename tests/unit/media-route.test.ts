import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../../app/media/[...path]/route";
import { variantsRoot } from "@/server/media/variants";

const hash = "c".repeat(64);
const path = ["aa", "bb", `${hash}.jpg`];

afterEach(async () => {
  await rm(join(variantsRoot(), "aa"), { recursive: true, force: true });
});

describe("media derivative route", () => {
  it("rejects originals and traversal-shaped paths", async () => {
    const original = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ path: ["../originals", "x.jpg"] }),
    });
    expect(original.status).toBe(404);
    const disguised = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ path: ["aa", "bb", `${hash}-social-1200x630.avif`] }),
    });
    expect(disguised.status).toBe(404);
  });

  it("serves the og:image social crop the worker writes (KBS-13)", async () => {
    const social = ["aa", "bb", `${hash}-social-1200x630.jpg`];
    await mkdir(join(variantsRoot(), "aa", "bb"), { recursive: true });
    await writeFile(join(variantsRoot(), ...social), "social");
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ path: social }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("serves safe derivatives with immutable cache and content type", async () => {
    const absolute = join(variantsRoot(), ...path);
    await mkdir(join(variantsRoot(), "aa", "bb"), { recursive: true });
    await writeFile(absolute, "test-image");
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ path }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe("test-image");
  });
});
