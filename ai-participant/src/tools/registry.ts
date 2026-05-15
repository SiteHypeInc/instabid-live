import type { Tool } from "./_shared.js";
import { CountertopPriceTool } from "./countertop-price.js";
import { ElectricalPriceTool } from "./electrical-price.js";
import { PlumbingPriceTool } from "./plumbing-price.js";
import { PaintingPriceTool } from "./painting-price.js";
import { FlooringPriceTool } from "./flooring-price.js";
import { HvacPriceTool } from "./hvac-price.js";
import { RoofingPriceTool } from "./roofing-price.js";
import { DrywallPriceTool } from "./drywall-price.js";
import { SidingPriceTool } from "./siding-price.js";
import { UnknownMaterialPriceTool } from "./unknown-material-price.js";

export const ALL_TOOLS: readonly Tool[] = [
  CountertopPriceTool,
  ElectricalPriceTool,
  PlumbingPriceTool,
  PaintingPriceTool,
  FlooringPriceTool,
  HvacPriceTool,
  RoofingPriceTool,
  DrywallPriceTool,
  SidingPriceTool,
  UnknownMaterialPriceTool,
];

export const TOOLS_BY_NAME: Readonly<Record<string, Tool>> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.declaration.name, t]),
);
