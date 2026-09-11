/** E-08 Audio — emote sound must be a supported format, within budget, and match the clip so it neither cuts off nor trails behind. */
import { parseBuffer } from "music-metadata";
import { clipDuration, emoteOnly, round3 } from "../../../logic/animation.js";
import { finding, type CheckDefinition, type CheckMeta, type Finding, type ParsedModel } from "../../../types.js";
import { PROPS } from "../../docs.js";

const meta: CheckMeta = { name: "audio", group: "emote", rule: "E-08", docs: `${PROPS}#format-and-limitations-for-audio-clips` };

// Audio format lists are structural (rule E-08), not tunable limits — they live here, next to the manifest numbers.
const VALID_AUDIO_EXTENSIONS = [".mp3", ".ogg"];
const AUDIO_LIKE_EXTENSIONS = [".mp3", ".ogg", ".wav", ".aac", ".m4a", ".flac", ".opus", ".wma"];
const AUDIO_MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };
// The display measure counts a narrower set than the run inspects — kept as-is so measured strings stay byte-identical.
const MEASURED_AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav", ".aac", ".m4a", ".flac"];

const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;
const mbLabel = (bytes: number): string => `${Math.round((bytes / 1048576) * 100) / 100} MB`;

function avatarClipSeconds(models: ParsedModel[]): number | undefined {
  let max: number | undefined;
  for (const model of models) {
    const anims = model.doc.getRoot().listAnimations();
    if (anims.length === 0) continue;
    const avatarClips = anims.filter((a) => a.getName().endsWith("_Avatar"));
    const used = avatarClips.length > 0 ? avatarClips : anims;
    for (const anim of used) {
      const seconds = clipDuration(anim);
      if (max === undefined || seconds > max) max = seconds;
    }
  }
  return max;
}

export const audio: CheckDefinition = {
  ...meta,
  title: "Audio",
  describe: "audio is .mp3/.ogg, within the size budget, and matches the animation length",
  explanation: "Emote audio must be .mp3 or .ogg, within the size limit, and roughly the same length as the animation.",
  fix: "Convert the sound to .mp3 or .ogg, trim it to the animation's length, and keep total audio under the size limit.",
  details: "Validates the audio extension (.mp3/.ogg) and total size, and parses the real audio duration to compare against the clip (±0.5 s warns).",
  appliesTo: emoteOnly,
  measure: (ctx) => {
    let count = 0;
    let bytes = 0;
    for (const [path, data] of ctx.files) {
      if (MEASURED_AUDIO_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
        count++;
        bytes += data.length;
      }
    }
    return count > 0 ? `${count} file${count === 1 ? "" : "s"} · ${mbLabel(bytes)}` : "no audio";
  },
  run: async (ctx) => {
    const findings: Finding[] = [];
    const { audioDurationToleranceSeconds } = ctx.manifest.emote;
    const limitBytes = ctx.manifest.fileSize.audioBytes;
    const audioFiles: { path: string; bytes: Uint8Array; ext: string }[] = [];
    for (const [path, bytes] of ctx.files) {
      const dot = path.lastIndexOf(".");
      const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
      if (AUDIO_LIKE_EXTENSIONS.includes(ext)) audioFiles.push({ path, bytes, ext });
    }
    if (audioFiles.length === 0) return findings;
    let totalBytes = 0;
    for (const file of audioFiles) {
      totalBytes += file.bytes.length;
      if (!VALID_AUDIO_EXTENSIONS.includes(file.ext)) {
        findings.push(
          finding(meta, "error", `"${file.path}" is a ${file.ext} file — emote audio must be ${VALID_AUDIO_EXTENSIONS.join(" or ")}. Convert the file.`, {
            where: file.path,
            measured: file.ext,
            limit: VALID_AUDIO_EXTENSIONS.join("/")
          })
        );
      }
    }
    if (totalBytes > limitBytes) {
      findings.push(
        finding(meta, "error", `Audio files total ${mb(totalBytes)} MB — the audio budget is ${mb(limitBytes)} MB. Compress or shorten the audio.`, {
          measured: totalBytes,
          limit: limitBytes,
          data: { files: audioFiles.map((f) => f.path) }
        })
      );
    }
    const clipSeconds = avatarClipSeconds(ctx.models);
    for (const file of audioFiles) {
      if (!VALID_AUDIO_EXTENSIONS.includes(file.ext)) continue;
      let seconds: number | undefined;
      try {
        seconds = (await parseBuffer(file.bytes, AUDIO_MIME[file.ext])).format.duration;
      } catch {
        seconds = undefined;
      }
      if (seconds === undefined || !Number.isFinite(seconds)) {
        findings.push(
          finding(meta, "warning", `Couldn't read the duration of "${file.path}" — make sure it's a valid ${file.ext} file so the audio can be checked against the animation length.`, {
            where: file.path
          })
        );
      } else if (clipSeconds !== undefined && Math.abs(seconds - clipSeconds) > audioDurationToleranceSeconds) {
        findings.push(
          finding(
            meta,
            "warning",
            `"${file.path}" lasts ${round3(seconds)} s but the animation lasts ${round3(clipSeconds)} s — audio should match the clip within ${audioDurationToleranceSeconds} s so it doesn't cut off or trail behind.`,
            { where: file.path, measured: round3(seconds), limit: round3(clipSeconds) }
          )
        );
      }
    }
    return findings;
  }
};
