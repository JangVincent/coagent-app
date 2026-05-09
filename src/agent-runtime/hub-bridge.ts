import { encode, MSG, type Participant } from "../shared/protocol.ts";
import type { HubChatBridge } from "./backends/types.ts";

export interface HubBridgeDeps {
  getWs(): WebSocket | null;
  getRoster(): Participant[];
}

export function createHubBridge(deps: HubBridgeDeps): HubChatBridge {
  let callCount = 0;
  return {
    sendChatMessage(content: string) {
      const ws = deps.getWs();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encode({ type: MSG.MESSAGE, content }));
        callCount += 1;
      }
    },
    getCallCount() {
      return callCount;
    },
    getRoster() {
      return deps.getRoster().map((p) => ({ name: p.name, role: p.role }));
    },
  };
}
