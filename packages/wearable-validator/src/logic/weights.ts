/** Skin-weight accessor reading shared by bone-weights and hands-geometry — dequantizes normalized integer storage. */
import { Accessor } from "@gltf-transform/core";

function normalizedScale(acc: Accessor): number {
  if (!acc.getNormalized()) return 1;
  switch (acc.getComponentType()) {
    case Accessor.ComponentType.UNSIGNED_BYTE: return 255;
    case Accessor.ComponentType.UNSIGNED_SHORT: return 65535;
    case Accessor.ComponentType.BYTE: return 127;
    case Accessor.ComponentType.SHORT: return 32767;
    default: return 1;
  }
}

/** Reads a VEC4 element, dequantizing normalized integer storage to floats. */
export function readVec4(acc: Accessor, index: number): [number, number, number, number] {
  const arr = acc.getArray();
  if (!arr) return [0, 0, 0, 0];
  const scale = normalizedScale(acc);
  const o = index * 4;
  return [(arr[o] ?? 0) / scale, (arr[o + 1] ?? 0) / scale, (arr[o + 2] ?? 0) / scale, (arr[o + 3] ?? 0) / scale];
}

export const round4 = (n: number): number => Math.round(n * 10000) / 10000;
