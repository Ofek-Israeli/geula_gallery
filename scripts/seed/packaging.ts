/**
 * Packaging defaults for the demo catalog (spec §8.3 "Packaging defaults", explicit):
 * - canvas → STRETCHED_BOX, artwork depth 30 mm; board or cardboard → FLAT_BOX, 10 mm;
 *   paper → FLAT_BOX, 2 mm; a crate when the manifest says so (109693);
 * - packed length and width = artwork + 120 mm in total (canvas, board) or + 80 mm (paper);
 *   packed height = depth + 80 mm;
 * - packed weight = 1,500 g + 6,000 g × artwork area (m²), rounded to the gram;
 * - a rollable canvas ships as a ROLLED_TUBE: the shorter side + 100 mm, × 260 × 260 mm.
 * Pure; unit-tested against the §8.3 expected-class table.
 */
import { rolledTubeBox } from "@/server/shipping/rates";
import type { PackagingType } from "@/server/shipping/types";

export type DemoSurface = "CANVAS" | "BOARD" | "CARDBOARD" | "PAPER";

export interface DemoPackaging {
  depthMm: number;
  packagingType: PackagingType;
  packedLengthMm: number;
  packedWidthMm: number;
  packedHeightMm: number;
  packedWeightG: number;
}

const DEPTH_MM: Record<DemoSurface, number> = {
  CANVAS: 30,
  BOARD: 10,
  CARDBOARD: 10,
  PAPER: 2,
};

export function demoPackaging(w: {
  heightMm: number;
  widthMm: number;
  surface: DemoSurface;
  canBeRolled: boolean;
  crate: boolean;
}): DemoPackaging {
  const depthMm = DEPTH_MM[w.surface];
  const margin = w.surface === "PAPER" ? 80 : 120;
  const areaM2 = (w.heightMm / 1000) * (w.widthMm / 1000);
  const packedWeightG = Math.round(1500 + 6000 * areaM2);
  if (w.canBeRolled) {
    const tube = rolledTubeBox(w);
    return {
      depthMm,
      packagingType: "ROLLED_TUBE",
      packedLengthMm: tube.lengthMm,
      packedWidthMm: tube.widthMm,
      packedHeightMm: tube.heightMm,
      packedWeightG,
    };
  }
  return {
    depthMm,
    packagingType: w.crate
      ? "CRATE"
      : w.surface === "CANVAS"
        ? "STRETCHED_BOX"
        : "FLAT_BOX",
    packedLengthMm: w.heightMm + margin,
    packedWidthMm: w.widthMm + margin,
    packedHeightMm: depthMm + 80,
    packedWeightG,
  };
}
