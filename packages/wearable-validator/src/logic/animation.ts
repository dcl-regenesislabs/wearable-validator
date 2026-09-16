/** Keyframe/skeleton helpers shared by the emote checks — sampler access, clip length, node parents, and the emote-only gate. */
import type { Animation, AnimationChannel, AnimationSampler, Node } from "@gltf-transform/core";
import type { CheckContext } from "../types.js";

export function emoteOnly(ctx: CheckContext): true | string {
  return ctx.itemType === "emote" ? true : "emote-only check — this item is a wearable";
}

export interface ChannelKeys {
  sampler: AnimationSampler;
  count: number;
}

export function channelKeys(channel: AnimationChannel): ChannelKeys | null {
  const sampler = channel.getSampler();
  const input = sampler?.getInput();
  if (!sampler || !input) return null;
  return { sampler, count: input.getCount() };
}

export function keyTime(keys: ChannelKeys, index: number): number {
  return keys.sampler.getInput()!.getElement(index, [0])[0];
}

/** Output value at a key — CUBICSPLINE stores in-tangent/value/out-tangent per key, so pick the middle element. */
export function keyValue(keys: ChannelKeys, index: number, components: number): number[] {
  const output = keys.sampler.getOutput();
  if (!output) return new Array<number>(components).fill(0);
  const stride = keys.sampler.getInterpolation() === "CUBICSPLINE" ? 3 : 1;
  return output.getElement(index * stride + (stride === 3 ? 1 : 0), new Array<number>(components).fill(0));
}

export function clipDuration(anim: Animation): number {
  let max = 0;
  for (const channel of anim.listChannels()) {
    const keys = channelKeys(channel);
    if (!keys) continue;
    for (let i = 0; i < keys.count; i++) {
      const t = keyTime(keys, i);
      if (t > max) max = t;
    }
  }
  return max;
}

export function parentNode(node: Node): Node | null {
  return (node.listParents().find((p) => p.propertyType === "Node") as Node | undefined) ?? null;
}

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
