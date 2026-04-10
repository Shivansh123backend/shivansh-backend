export interface CallOptions {
  to: string;
  from: string;
  voiceId?: string;
  agentPrompt?: string;
  callId: number;
  metadata?: Record<string, unknown>;
}

export interface TransferOptions {
  callId: number;
  externalCallId: string;
  targetAgentPhone?: string;
  targetSipUri?: string;
}

export interface HangupOptions {
  externalCallId: string;
}

export interface CallResult {
  externalCallId: string;
  status: "initiated" | "failed";
  provider: string;
}

export abstract class CallProvider {
  abstract readonly name: string;

  abstract call(options: CallOptions): Promise<CallResult>;
  abstract transfer(options: TransferOptions): Promise<void>;
  abstract hangup(options: HangupOptions): Promise<void>;
}
