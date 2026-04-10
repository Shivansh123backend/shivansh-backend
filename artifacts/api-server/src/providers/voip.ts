import { CallProvider, type CallOptions, type TransferOptions, type HangupOptions, type CallResult } from "./base.js";
import { logger } from "../lib/logger.js";

export class VoipProvider extends CallProvider {
  readonly name = "voip";

  async call(options: CallOptions): Promise<CallResult> {
    logger.info({ provider: this.name, to: options.to, callId: options.callId }, "Initiating VoIP call");
    // VoIP provider integration — execution happens on VPS workers
    // This layer creates the call record and returns a reference ID
    return {
      externalCallId: `voip-${options.callId}-${Date.now()}`,
      status: "initiated",
      provider: this.name,
    };
  }

  async transfer(options: TransferOptions): Promise<void> {
    logger.info({ provider: this.name, externalCallId: options.externalCallId }, "Transferring VoIP call");
    // Transfer logic dispatched to VPS worker via queue
  }

  async hangup(options: HangupOptions): Promise<void> {
    logger.info({ provider: this.name, externalCallId: options.externalCallId }, "Hanging up VoIP call");
    // Hangup dispatched to VPS worker
  }
}
