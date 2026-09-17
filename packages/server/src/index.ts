import { Lifecycle } from "@well-known-components/interfaces";
import { initComponents } from "./components.js";
import { main } from "./service.js";

// the program entry point: it only calls the Lifecycle function
void Lifecycle.run({ main, initComponents });
