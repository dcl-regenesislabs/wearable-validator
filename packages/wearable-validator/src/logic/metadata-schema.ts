import { Emote, Wearable } from "@dcl/schemas";
import type { Finding, ItemType } from "../types.js";

export function metadataSchemaFindings(metadata: unknown, itemType: ItemType, docs: string): Finding[] {
  const findings: Finding[] = [];
  const add = (where: string, message: string, measured?: string, limit?: string) => {
    if (findings.some((entry) => entry.where === where && entry.message === message)) return;
    findings.push({
      check: "metadata", group: "files", rule: "S-03", severity: "error",
      docs, where, measured, limit,
      message
    });
  };
  let candidate = metadata;
  if (metadata !== null && typeof metadata === "object" && "id" in metadata && typeof metadata.id !== "string") {
    add("id", "Item ID must be a string — supply the item identifier in metadata.", JSON.stringify(metadata.id));
    // Schema custom keywords call id.split before checking its type.
    candidate = { ...metadata, id: "" };
  }
  const validate = itemType === "emote" ? Emote.validate : Wearable.validate;
  if (validate(candidate)) return findings;
  const item = candidate !== null && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const id = typeof item.id === "string" ? item.id : "";
  const branch = /^urn:decentraland:off-chain:base-(avatars|emotes):[^:]+$/.test(id) ? 0 : "merkleProof" in item || "content" in item ? 2 : 1;
  for (const error of validate.errors ?? []) {
    // Other oneOf branches describe alternative item kinds, not missing fields on this item.
    const alternative = error.schemaPath.match(itemType === "emote" ? /^#\/oneOf\/0\/oneOf\/(\d+)\// : /^#\/oneOf\/(\d+)\//);
    if (alternative && Number(alternative[1]) !== branch) continue;
    if (!error.message) continue;
    const parts = error.instancePath.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (error.keyword === "required" && typeof error.params.missingProperty === "string") parts.push(error.params.missingProperty);
    const where = parts.join(".") || "metadata";
    let value: unknown = metadata;
    for (const part of parts) {
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    }
    const message = error.keyword.startsWith("_is")
      ? "Item identity must match a supported base, standard, or third-party item — check its ID and supplied metadata."
      : `${where}: ${error.message} — correct this field in the supplied ${itemType} metadata.`;
    const requirement = error.keyword === "enum" ? JSON.stringify(error.params.allowedValues)
      : error.keyword === "type" ? String(error.params.type)
      : error.keyword === "required" ? "Required" : undefined;
    add(where, message, value === undefined ? "Missing" : JSON.stringify(value), requirement);
  }
  return findings;
}
