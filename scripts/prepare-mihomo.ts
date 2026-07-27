import path from "node:path";
import { preparePinnedDevelopmentMihomo } from "./development-mihomo.ts";

const verification = await preparePinnedDevelopmentMihomo(path.resolve("."));
console.log(`Prepared and verified ${verification.binary}`);
