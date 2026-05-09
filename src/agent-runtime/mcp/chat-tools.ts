import { z } from "zod";
import type { HubChatBridge } from "../backends/types.ts";

export interface ChatToolDeps {
  agentName: string;
  bridge: HubChatBridge;
}

export const SEND_CHAT_DESCRIPTION =
  "Send a message to the group chat. Use @name to address a participant. This is the ONLY way to deliver a message to other participants — anything else you output stays local.";

export const GET_PARTICIPANTS_DESCRIPTION =
  "Get the current list of participants in the chat room. Returns names and roles (human/agent).";

export const SEND_CHAT_INPUT_SHAPE = {
  content: z
    .string()
    .describe(
      "Message text. Use @name to mention participants. For file references, just write the path.",
    ),
} as const;

export const GET_PARTICIPANTS_INPUT_SHAPE = {} as const;

export interface SendChatArgs {
  content: string;
}

export function makeSendChatHandler(deps: ChatToolDeps) {
  return async ({ content }: SendChatArgs) => {
    deps.bridge.sendChatMessage(content);
    process.stdout.write(`[${deps.agentName} -> chat] ${content}\n`);
    return { content: [{ type: "text" as const, text: "sent" }] };
  };
}

export function makeGetParticipantsHandler(deps: ChatToolDeps) {
  return async () => {
    const roster = deps.bridge.getRoster();
    const list =
      roster.length > 0
        ? roster.map((p) => `${p.name} (${p.role})`).join(", ")
        : "(no participants)";
    return { content: [{ type: "text" as const, text: list }] };
  };
}
