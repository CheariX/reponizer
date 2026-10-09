import { Clipboard, Toast, open } from "@raycast/api";
import type { RemoteOutcome } from "../lib/hosting";
import { hostWebUrl } from "../lib/remotes";
import { errorDetails, errorMessage } from "../lib/util";

export interface OutcomeWording {
  /** URL of the new repository; its host's website is where the user creates it by hand. */
  url: string;
  remoteHost: string;
  relativePath: string;
  /** "Created" or "Forked". */
  verb: string;
  /** Title once the repository is on its host, e.g. "Repository created". */
  doneTitle: string;
  /** What the user does on the host when nothing created the repository there. */
  createHint: string;
  /** The action that pushes afterwards: "Publish Branch" or "Push to Origin". */
  pushAction: string;
}

/** Report where a new local copy stands with its host on the toast that tracked the operation. */
export function showRemoteOutcome(toast: Toast, outcome: RemoteOutcome, wording: OutcomeWording): void {
  switch (outcome.state) {
    case "published":
      toast.style = Toast.Style.Success;
      toast.title = wording.doneTitle;
      toast.message = wording.relativePath;
      return;
    case "push-failed": {
      const { error } = outcome;
      toast.style = Toast.Style.Failure;
      toast.title = `${wording.verb} on GitHub, but the push failed`;
      toast.message = `${errorMessage(error)} — retry with “${wording.pushAction}”.`;
      toast.primaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(errorDetails(error)) };
      return;
    }
    case "needs-remote": {
      const { problem, error } = outcome;
      const hostUrl = hostWebUrl(wording.url);
      const nextStep = `${wording.createHint}, then use “${wording.pushAction}”.`;
      // Without a problem this is the planned route for the host, not a failure.
      toast.style = problem ? Toast.Style.Failure : Toast.Style.Success;
      toast.title = problem ? `${wording.verb} locally, but not on ${wording.remoteHost}` : `${wording.verb} locally`;
      toast.message = problem ? `${problem.replace(/\.?$/, ".")} ${nextStep}` : nextStep;
      if (hostUrl) toast.primaryAction = { title: "Open Host in Browser", onAction: () => open(hostUrl) };
      if (problem) {
        const details = error ? errorDetails(error) : problem;
        toast.secondaryAction = { title: "Copy Error", onAction: () => Clipboard.copy(details) };
      }
      return;
    }
  }
}
