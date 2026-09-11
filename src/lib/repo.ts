/**
 * Where this build points when it sends someone to the project.
 *
 * Three files each spelled the repository out for themselves — the release
 * notes link, the rpm-ostree command, and the "Report issue" URL — so moving
 * the project meant finding all three (#345).
 */

const OWNER = "EVWorth";
const REPO = "sqlpilot";

export const REPO_URL = `https://github.com/${OWNER}/${REPO}`;

/** The release page for a version, as the tags are named. */
export function releaseUrl(version: string): string {
  return `${REPO_URL}/releases/tag/v${version}`;
}

/** A downloadable asset from a release. */
export function releaseAssetUrl(version: string, filename: string): string {
  return `${REPO_URL}/releases/download/v${version}/${filename}`;
}

/**
 * Labels the project actually triages by.
 *
 * The old link asked for `bug,auto-update`. Neither is quite right: the repo
 * uses `kind/bug`, and `auto-update` does not exist at all — GitHub drops a
 * label it does not recognise, so the report arrived unlabelled and missed
 * every triage filter it was supposed to land in (#345).
 */
export const UPDATE_ISSUE_LABELS = ["kind/bug", "area/updates"];

export interface NewIssue {
  title: string;
  body: string;
  labels?: string[];
}

/**
 * A pre-filled "new issue" URL.
 *
 * Percent-encoded by hand rather than through URLSearchParams, which writes
 * spaces as `+`. GitHub accepts both, but `+` does not survive a
 * `decodeURIComponent`, so the URL stops being readable by the first person
 * who tries to check what it contains.
 */
export function newIssueUrl({ title, body, labels }: NewIssue): string {
  const parts = [
    `title=${encodeURIComponent(title)}`,
    `body=${encodeURIComponent(body)}`,
  ];
  if (labels?.length) parts.push(`labels=${encodeURIComponent(labels.join(","))}`);
  return `${REPO_URL}/issues/new?${parts.join("&")}`;
}
