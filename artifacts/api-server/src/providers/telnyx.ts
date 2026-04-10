import { CallProvider, type CallOptions, type TransferOptions, type HangupOptions, type CallResult } from "./base.js";
import { logger } from "../lib/logger.js";

export class TelnyxProvider extends CallProvider {
  readonly name = "telnyx";

  async call(options: CallOptions): Promise<CallResult> {
    logger.info({ provider: this.name, to: options.to, callId: options.callId }, "Initiating Telnyx call");
    return {
      externalCallId: `telnyx-${options.callId}-${Date.now()}`,
      status: "initiated",
      provider: this.name,
    };
  }

  async transfer(options: TransferOptions): Promise<void> {
    logger.info({ provider: this.name, externalCallId: options.externalCallId }, "Transferring Telnyx call");
  }

  async hangup(options: HangupOptions): Promise<void> {
    logger.info({ provider: this.name, externalCallId: options.externalCallId }, "Hanging up Telnyx call");
  }
}
