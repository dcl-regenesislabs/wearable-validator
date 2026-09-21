/** P4 Rendering & visual QA — render-valid gates the rest; every rule below reuses the same capture recipe (twelve views for a wearable, twenty frames for an emote). */
import { renderValid } from "./render-valid/index.js";
import { thumbnailHonesty } from "./thumbnail-honesty/index.js";
import { visualQuality } from "./visual-quality/index.js";
import { emoteQuality } from "./emote-quality/index.js";

export const renderingChecks = [renderValid, thumbnailHonesty, visualQuality, emoteQuality];
