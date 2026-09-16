/** P3 Emote — rule-book order. */
import { duration } from "./duration/index.js";
import { animationClips } from "./animation-clips/index.js";
import { boneTargets } from "./bone-targets/index.js";
import { loopSeam } from "./loop-seam/index.js";
import { rootMotion } from "./root-motion/index.js";
import { clipNames } from "./clip-names/index.js";
import { props } from "./props/index.js";
import { audio } from "./audio/index.js";
import { socialOutcomes } from "./social-outcomes/index.js";

export const emoteChecks = [duration, animationClips, boneTargets, loopSeam, rootMotion, clipNames, props, audio, socialOutcomes];
