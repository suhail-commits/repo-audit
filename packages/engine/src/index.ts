export {
  buildContext,
  scanRepository,
  scanGitHubRepository,
  type ScanOptions,
  type GitHubScanOptions,
} from "./scan";
export type { AnalysisContext } from "./analyzers/context";

export {
  analyzeProvenance,
  GROUND_TRUTH_SIGNAL_IDS,
  type ProvenanceOptions,
  type ProvenanceResult,
} from "./analyzers/provenance/index";

export { scoreDimension, provenanceBand } from "./score/index";

export {
  fetchRepoMeta,
  fetchTarball,
  fetchCommits,
  isValidSlug,
  GitHubError,
  type RepoMeta,
  type TarballResult,
  type CommitHistory,
  type GitHubOptions,
} from "./ingest/github";
export { LIMITS } from "./ingest/guards";

export { FileIndex, type IndexedFile } from "./index/files";
export { AstIndex, walk, collect, memberPath, type AstNode } from "./index/ast";
export { GitIndex, type Commit } from "./index/git";
export { ImportGraph } from "./index/imports";
export { RouteTable, type Route, type HttpMethod } from "./index/routes";
export { detectFrameworks, type FrameworkInfo } from "./index/frameworks";
