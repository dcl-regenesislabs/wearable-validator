import { docsUrl, type CheckDefinition } from "../types.js";
// F-04 deterministic half — implemented in a follow-up commit (agent-assigned).
export const qrCodeCheck: CheckDefinition = {
  name: "qr-code", group: "content", rule: "F-04", title: "QR codes",
  describe: "no decodable QR codes in textures or the thumbnail",
  run: () => []
};
