import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ingestArtworkImage,
  ingestPrivatePhoto,
  probeImage,
  rgbToHex,
  UnsupportedImageError,
} from "@/server/media/ingest";

/** A JPEG with EXIF (incl. GPS), a Display P3 profile and orientation 6 (rotate 90° CW). */
async function cameraJpeg(width = 3000, height = 2000): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .withIccProfile("p3")
    .withExif({
      IFD0: { Make: "TestCam", Model: "X1" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "32/1 4/1 0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "34/1 46/1 0/1",
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe("probeImage", () => {
  it("accepts JPEG, PNG and WebP by content", async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#fff" },
    })
      .png()
      .toBuffer();
    expect(await probeImage(png)).toEqual({
      format: "png",
      width: 4,
      height: 3,
    });
  });

  it("rejects other formats and garbage", async () => {
    const gif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#000" },
    })
      .gif()
      .toBuffer();
    await expect(probeImage(gif)).rejects.toMatchObject({ reason: "format" });
    await expect(
      probeImage(new TextEncoder().encode("<svg></svg>")),
    ).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(probeImage(new Uint8Array())).rejects.toMatchObject({
      reason: "corrupt",
    });
  });
});

describe("ingestArtworkImage", () => {
  it("strips EXIF/GPS, applies orientation, converts to sRGB and bounds the master", async () => {
    const input = await cameraJpeg();
    const inMeta = await sharp(input).metadata();
    expect(inMeta.exif).toBeDefined();
    expect(inMeta.orientation).toBe(6);

    const out = await ingestArtworkImage(input);
    const meta = await sharp(out.master.body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.space).toBe("srgb");
    expect(meta.icc).toBeDefined(); // embedded sRGB profile, not P3
    // orientation 6 swaps the axes; long side capped at 2400
    expect(out.master.width).toBe(1600);
    expect(out.master.height).toBe(2400);
    expect(out.master.bytes).toBe(out.master.body.byteLength);

    const og = await sharp(out.og.body).metadata();
    expect([og.width, og.height]).toEqual([1200, 630]);
    expect(og.exif).toBeUndefined();

    expect(out.blurDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(out.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(out.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // the private original is kept untouched
    expect(out.original.body).toBe(input);
    expect(out.original.ext).toBe("jpg");
  });

  it("never enlarges small images", async () => {
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const out = await ingestArtworkImage(small);
    expect([out.master.width, out.master.height]).toEqual([300, 200]);
    // sharp bins the histogram, so the dominant colour is approximate
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(out.dominantColor.slice(i, i + 2), 16),
    );
    expect(Math.abs((r ?? 0) - 0x12)).toBeLessThanOrEqual(16);
    expect(Math.abs((g ?? 0) - 0x34)).toBeLessThanOrEqual(16);
    expect(Math.abs((b ?? 0) - 0x56)).toBeLessThanOrEqual(16);
  });
});

describe("ingestPrivatePhoto", () => {
  it("rotates, strips metadata and downsizes packing photos", async () => {
    const out = await ingestPrivatePhoto(await cameraJpeg(4000, 3000));
    const meta = await sharp(out.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect([out.width, out.height]).toEqual([1800, 2400]);
  });
});

describe("rgbToHex", () => {
  it("formats and clamps", () => {
    expect(rgbToHex({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
    expect(rgbToHex({ r: 300, g: -4, b: 15.6 })).toBe("#ff0010");
  });
});
