import type { PendingInteraction } from "./types.js";
export type Elicitor = (params: Record<string, unknown>) => Promise<unknown>;
export declare function resolveInteraction(interaction: PendingInteraction, elicit?: Elicitor): Promise<void>;
