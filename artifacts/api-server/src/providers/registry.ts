import { type CallProvider } from "./base.js";
import { VoipProvider } from "./voip.js";
import { TelnyxProvider } from "./telnyx.js";
import { TwilioProvider } from "./twilio.js";
import { logger } from "../lib/logger.js";

const providers: Record<string, CallProvider> = {
  voip: new VoipProvider(),
  telnyx: new TelnyxProvider(),
  twilio: new TwilioProvider(),
};

const providerFallbackOrder: Array<keyof typeof providers> = ["voip", "telnyx", "twilio"];

export function getProvider(name: string): CallProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

export async function callWithFallback(
  preferredProvider: string,
  options: Parameters<CallProvider["call"]>[0],
): Promise<{ result: Awaited<ReturnType<CallProvider["call"]>>; provider: string }> {
  const order = [
    preferredProvider,
    ...providerFallbackOrder.filter((p) => p !== preferredProvider),
  ];

  let lastError: Error | null = null;

  for (const providerName of order) {
    try {
      const provider = getProvider(providerName);
      const result = await provider.call(options);
      return { result, provider: providerName };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn({ provider: providerName, err: lastError }, "Provider call failed, trying fallback");
    }
  }

  throw lastError ?? new Error("All providers failed");
}
