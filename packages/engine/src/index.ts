export {
  assertScannable,
  buildContext,
  scanRepository,
  scanGitHubRepository,
  type ScanOptions,
  type GitHubScanOptions,
  type ProgressOptions,
  type ScanStage,
} from "./scan";
export { probeStructuralParsers, type ParserProbe } from "./index/structural";
export type { AnalysisContext } from "./analyzers/context";

export {
  analyzeAuthorship,
  GROUND_TRUTH_SIGNAL_IDS,
  type AuthorshipOptions,
  type AuthorshipResult,
} from "./analyzers/authorship/index";

export { analyzeHealth, type HealthResult } from "./analyzers/health/index";

export {
  analyzeSecurity,
  type SecurityOptions,
  type SecurityResult,
} from "./analyzers/security/index";

export { scoreDimension, authorshipBand } from "./score/index";

export {
  fetchRepoMeta,
  fetchTarball,
  fetchBranches,
  fetchCommits,
  isValidSlug,
  GitHubError,
  type RepoMeta,
  type TarballResult,
  type BranchList,
  type CommitHistory,
  type GitHubOptions,
} from "./ingest/github";
export { LIMITS } from "./ingest/guards";

export { FileIndex, type IndexedFile } from "./index/files";
export { AstIndex, walk, collect, memberPath, type AstNode } from "./index/ast";
export { GitIndex, checkedOutBranch, type Commit } from "./index/git";
export { ImportGraph } from "./index/imports";
export { RouteTable, type Route, type HttpMethod } from "./index/routes";
export { detectFrameworks, type FrameworkInfo } from "./index/frameworks";
