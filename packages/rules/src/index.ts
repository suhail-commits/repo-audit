export { TemplateNarrator } from "./narrator";
export type {
  Narrator,
  NarratedFinding,
  NarratedReport,
  NarratedScore,
} from "./types";
export {
  RULE_TEMPLATES,
  FALLBACK_TEMPLATE,
  templateFor,
  templatedRuleIds,
  type RuleTemplate,
} from "./templates";
export {
  signalLabel,
  labelledSignalIds,
  type SignalLabel,
} from "./signal-labels";
export { corpusComparison } from "./corpus";
export {
  coverageLine,
  scoreCaption,
  dimensionLabel,
  hotspotTitle,
  hotspotCaveat,
  notAnalysedHeadline,
  prioritiesTitle,
  prioritiesCaveat,
  type DimensionLabel,
} from "./dimension-labels";
