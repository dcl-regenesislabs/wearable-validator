/** P4 Rendering & visual QA — rule-book order: render-valid gates the rest; a model call never sees an empty render. */
import { renderValid } from "./render-valid/index.js";
import { thumbnailHonesty } from "./thumbnail-honesty/index.js";

export const renderingChecks = [renderValid, thumbnailHonesty];
