import { existsSync } from "node:fs";
import path from "node:path";

import { checkedOutBranch, fetchBranches, fetchRepoMeta } from "@vibe/engine";
import { parseRepoBranch, parseRepoSlug } from "@vibe/shared";

import type { Io } from "./io";
import { PromptCancelled, echoCommand, intro, select, text } from "./prompt";
import { accent, dim } from "./term";

/**
 * The guided flow, for someone who ran `repo-audit` with nothing.
 *
 * Only ever entered when a real terminal is on both ends and no repository was
 * named — every existing invocation behaves exactly as it did before.
 *
 * It ends by printing the equivalent one-line command. A wizard that hides the
 * flags teaches nothing; one that shows them is a tutorial you only need once.
 */

export interface WizardAnswers {
  target: string;
  /** Only ever set for a remote repository. See `askBranch`. */
  ref?: string;
}

export async function runWizard(
  io: Io,
  token: string | undefined,
): Promise<WizardAnswers | null> {
  try {
    intro(io, "repo-audit — how much of a codebase looks AI-generated");

    const target = await askTarget(io);
    const slug = existsSync(target) ? null : parseRepoSlug(target);

    if (!slug) {
      // A local path. No branch question: `git log` reads HEAD and the file
      // index reads the working tree, so anything other than what is checked
      // out would score one branch's files against another's history.
      const branch = checkedOutBranch(path.resolve(target));
      if (branch) {
        io.stdout.write(dim(`  on branch ${accent(branch)} (whatever is checked out)\n`));
      }
      echoCommand(io, `repo-audit ${quote(target)}`);
      return { target };
    }

    const ref = await askBranch(io, slug, target, token);
    echoCommand(
      io,
      `repo-audit ${slug}${ref ? ` --branch ${quote(ref)}` : ""}`,
    );
    return ref ? { target: slug, ref } : { target: slug };
  } catch (err) {
    if (err instanceof PromptCancelled) return null;
    throw err;
  }
}

/**
 * What to scan.
 *
 * Defaults to the current directory when it is a git repository, because
 * someone who runs this inside a project almost certainly means that project,
 * and Enter should be the right answer.
 */
async function askTarget(io: Io): Promise<string> {
  const cwd = process.cwd();
  const here = existsSync(path.join(cwd, ".git")) ? "." : undefined;

  const answer = await text(
    io,
    "Which repository? A path, owner/repo, or a GitHub URL",
    here,
  );
  return answer;
}

/**
 * Which branch, for a remote repository only.
 *
 * A branch already present in a pasted URL wins without asking — someone who
 * pasted `/tree/develop` has answered the question. Otherwise the branch list
 * is fetched, which is **one extra request** against a budget of sixty an hour
 * unauthenticated, so it is paid only here and never during a plain scan.
 *
 * If listing fails for any reason the flow continues on the default branch
 * rather than dying: a branch picker is a convenience, and losing it should not
 * cost the user their scan.
 */
async function askBranch(
  io: Io,
  slug: string,
  original: string,
  token: string | undefined,
): Promise<string | undefined> {
  const pasted = parseRepoBranch(original);
  if (pasted) {
    io.stdout.write(
      `${accent("?")} Which branch? ${accent(pasted)} ${dim("(from the URL you pasted)")}\n`,
    );
    return pasted;
  }

  const opts = token ? { token } : {};
  try {
    const meta = await fetchRepoMeta(slug, opts);
    const list = await fetchBranches(slug, meta.defaultBranch, opts);
    if (list.names.length <= 1) return undefined;

    if (list.truncated) {
      io.stdout.write(
        dim(`  showing the first ${list.names.length} branches; there are more\n`),
      );
    }

    const chosen = await select(
      io,
      "Which branch?",
      list.names.map((name) => ({
        value: name,
        ...(name === list.defaultBranch ? { hint: "default" } : {}),
      })),
    );
    // Returning undefined for the default keeps the printed command shorter,
    // and the engine resolves the same branch either way.
    return chosen === list.defaultBranch ? undefined : chosen;
  } catch (err) {
    if (err instanceof PromptCancelled) throw err;
    io.stdout.write(
      dim("  couldn't list branches; using the repository's default\n"),
    );
    return undefined;
  }
}

/** Quote only when a shell would need it, so the printed command reads well. */
function quote(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}
