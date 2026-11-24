import {
  isAppSession,
  type RequesterDeps,
  type RequesterSession,
  requesterOf,
} from "../requester.ts";

// Where a tool approval card goes (decision 102). A Slack write that only its requester may
// approve goes to that person's DM, and the thread shows one waiting line, so the people in a
// shared thread do not see the draft. Every other request stays in the thread: an owner-only
// approval may wait for someone other than the requester, and a DM is already private.

export type ApprovalPlace = "direct-message" | "thread";

// The tools whose approval only the requester answers (`requesterResponse`).
const REQUESTER_APPROVED = new Set([
  "slack_post",
  "slack_dm",
  "slack_edit",
  "slack_bookmark",
  "slack_canvas",
  "main_thread_post",
  "standing_approval_add",
]);

export interface ApprovalRequest {
  request: { kind: string };
  call?: { name: string };
}

// Eve sends a DM card to `state.triggeringUserId` unless the turn is a person's own. A run's
// state names the event's author, so the run's requester replaces it before the card goes out.
export interface ApprovalChannelState {
  channelId: string | null;
  triggeringUserId: string | null;
}

export async function approvalPlace(
  request: ApprovalRequest,
  session: RequesterSession,
  state: ApprovalChannelState | undefined,
  deps: () => RequesterDeps,
): Promise<ApprovalPlace> {
  if (request.request.kind !== "approval") return "thread";
  if (!request.call || !REQUESTER_APPROVED.has(request.call.name)) return "thread";
  if (!state?.channelId || state.channelId.startsWith("D")) return "thread";
  if (!isAppSession(session)) return "direct-message";
  const requester = await requesterOf(session, deps).catch(() => undefined);
  if (!requester) return "thread";
  state.triggeringUserId = requester;
  return "direct-message";
}

// Eve posts "Waiting on approval from @person…" in the thread for a DM card and, once the person
// answers, edits it to "Answered: … by @person." Sym deletes the line instead, so the thread
// keeps no approval trace (decision 104). This takes the line's ts off Eve's card record, so
// Eve skips its edit, and returns it for the delete.
interface CardRecord {
  announcementTs?: string;
  requests: readonly { interactionId: string }[];
}

export function takeApprovalAnnouncement(
  state: { interactionCards?: readonly CardRecord[] },
  interactionId: string,
): string | undefined {
  const cards = state.interactionCards;
  const card = cards?.find((c) => c.requests.some((r) => r.interactionId === interactionId));
  if (!cards || !card?.announcementTs) return undefined;
  const { announcementTs, ...rest } = card;
  state.interactionCards = cards.map((c) => (c === card ? rest : c));
  return announcementTs;
}
