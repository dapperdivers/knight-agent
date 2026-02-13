/**
 * Tool registry — all custom tools available to knights.
 */

export { natsRespondToolDef, executeNatsRespond } from "./nats-respond.js";
export type { NatsRespondParams } from "./nats-respond.js";

export { webSearchToolDef, executeWebSearch } from "./web-search.js";
export type { WebSearchParams } from "./web-search.js";

export { webFetchToolDef, executeWebFetch } from "./web-fetch.js";
export type { WebFetchParams } from "./web-fetch.js";

/**
 * All tool definitions for SDK registration.
 */
import { natsRespondToolDef } from "./nats-respond.js";
import { webSearchToolDef } from "./web-search.js";
import { webFetchToolDef } from "./web-fetch.js";

export const allToolDefs = [natsRespondToolDef, webSearchToolDef, webFetchToolDef];
