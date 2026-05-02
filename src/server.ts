import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const ANKI_URL = "http://127.0.0.1:8765";
const ANKI_VERSION = 6;
const TIMEOUT_MS = 5000;

const API_KEY = process.env["ANKICONNECT_API_KEY"];
const READ_ONLY = process.env["READ_ONLY"] === "true";

if (!API_KEY) {
  process.stderr.write("ANKICONNECT_API_KEY is required\n");
  process.exit(1);
}

type ErrorCode =
  | "ANKI_NOT_RUNNING"
  | "ANKI_AUTH_FAILED"
  | "ANKI_TIMEOUT"
  | "REVIEW_NOT_ACTIVE"
  | "INVALID_STATE"
  | "READ_ONLY_MODE"
  | "ANKI_ERROR"
  | "INVALID_INPUT";

class AnkiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface AnkiResponse<T> {
  result: T | null;
  error: string | null;
}

async function invoke<T>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ANKI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        version: ANKI_VERSION,
        key: API_KEY,
        params,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new AnkiError(
        "ANKI_TIMEOUT",
        `AnkiConnect did not respond within ${TIMEOUT_MS}ms (action=${action})`,
      );
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new AnkiError(
        "ANKI_TIMEOUT",
        `AnkiConnect did not respond within ${TIMEOUT_MS}ms (action=${action})`,
      );
    }
    throw new AnkiError(
      "ANKI_NOT_RUNNING",
      `Could not reach AnkiConnect at ${ANKI_URL}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new AnkiError(
      "ANKI_ERROR",
      `AnkiConnect returned HTTP ${res.status}`,
    );
  }

  let body: AnkiResponse<T>;
  try {
    body = (await res.json()) as AnkiResponse<T>;
  } catch (err) {
    throw new AnkiError(
      "ANKI_ERROR",
      `AnkiConnect returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (body.error) {
    if (/valid api key/i.test(body.error)) {
      throw new AnkiError(
        "ANKI_AUTH_FAILED",
        "AnkiConnect rejected the API key",
      );
    }
    throw new AnkiError("ANKI_ERROR", body.error);
  }

  return body.result as T;
}

let healthChecked = false;
async function ensureHealthy(): Promise<void> {
  if (healthChecked) return;
  await invoke<number>("version");
  healthChecked = true;
}

let lastShownCardId: number | null = null;

interface CardInfo {
  cardId: number;
  question: string;
  answer: string;
  deckName: string;
  modelName: string;
  fieldOrder: number;
  fields: Record<string, { value: string; order: number }>;
  css: string;
  buttons: number[];
  nextReviews: string[];
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new AnkiError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
  return v;
}

function requireEase(v: unknown): 1 | 2 | 3 | 4 {
  if (v === 1 || v === 2 || v === 3 || v === 4) return v;
  throw new AnkiError("INVALID_INPUT", "ease must be 1, 2, 3, or 4");
}

// AnkiConnect's guiCurrentCard can return a cached card after the review
// window has closed, while guiShowAnswer/guiAnswerCard correctly report
// "Gui review is not currently active." Remap that error to REVIEW_NOT_ACTIVE.
function remapInactiveReview(e: unknown): never {
  if (
    e instanceof AnkiError &&
    e.code === "ANKI_ERROR" &&
    /review is not (currently )?active/i.test(e.message)
  ) {
    throw new AnkiError(
      "REVIEW_NOT_ACTIVE",
      "No card is currently shown in Anki's review window",
    );
  }
  throw e;
}

async function getCurrentCardOrNull(): Promise<CardInfo | null> {
  try {
    return await invoke<CardInfo | null>("guiCurrentCard");
  } catch (e) {
    if (
      e instanceof AnkiError &&
      e.code === "ANKI_ERROR" &&
      /review is not (currently )?active/i.test(e.message)
    ) {
      return null;
    }
    throw e;
  }
}

function requireCardIds(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new AnkiError("INVALID_INPUT", "cardIds must be a non-empty array");
  }
  for (const id of v) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw new AnkiError("INVALID_INPUT", "cardIds must contain integers");
    }
  }
  return v as number[];
}

// Anki cards embed template <style> and <script> blocks (Migaku, Yomichan, etc.)
// in every question/answer payload. Strip them so MCP responses stay readable.
function stripPresentationHtml(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

const TOOLS = [
  {
    name: "list_decks",
    description: "List all deck names in the Anki collection.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "start_review",
    description:
      "Open a deck into Anki's review mode. Clears the server's last-shown card.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", description: "Exact deck name." },
      },
      required: ["deck"],
      additionalProperties: false,
    },
  },
  {
    name: "current_card",
    description:
      "Return the card currently shown in Anki's review window. Returns { done: true } if no card is up. Read-only and callable any time.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "show_answer",
    description:
      "Flip the current card to its answer side. Required before answer_card.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "answer_card",
    description:
      "Submit a rating (1=Again, 2=Hard, 3=Good, 4=Easy) for the current card. Requires show_answer to have been called for this card.",
    inputSchema: {
      type: "object",
      properties: {
        ease: { type: "integer", enum: [1, 2, 3, 4] },
      },
      required: ["ease"],
      additionalProperties: false,
    },
  },
  {
    name: "find_cards",
    description: "Find cards matching an Anki search query. Returns card IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Anki search query (e.g. 'deck:日本語 is:due').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "card_details",
    description: "Inspect specific cards by ID.",
    inputSchema: {
      type: "object",
      properties: {
        cardIds: {
          type: "array",
          items: { type: "integer" },
          minItems: 1,
        },
      },
      required: ["cardIds"],
      additionalProperties: false,
    },
  },
] as const;

function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function err(code: ErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code, message }) }],
  };
}

async function handleCall(req: CallToolRequest): Promise<CallToolResult> {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  await ensureHealthy();

  switch (name) {
    case "list_decks": {
      const decks = await invoke<string[]>("deckNames");
      return ok({ decks });
    }

    case "start_review": {
      const deck = requireString(args["deck"], "deck");
      const opened = await invoke<boolean>("guiDeckReview", { name: deck });
      lastShownCardId = null;
      return ok({ opened });
    }

    case "current_card": {
      const card = await getCurrentCardOrNull();
      if (card === null) return ok({ done: true });
      return ok({
        cardId: card.cardId,
        question: stripPresentationHtml(card.question),
        answer: stripPresentationHtml(card.answer),
        deckName: card.deckName,
        buttons: card.buttons,
        nextReviews: card.nextReviews,
      });
    }

    case "show_answer": {
      const card = await getCurrentCardOrNull();
      if (card === null) {
        throw new AnkiError(
          "REVIEW_NOT_ACTIVE",
          "No card is currently shown in Anki's review window",
        );
      }
      const flipped = await invoke<boolean>("guiShowAnswer").catch(remapInactiveReview);
      lastShownCardId = card.cardId;
      return ok({ flipped, cardId: card.cardId });
    }

    case "answer_card": {
      if (READ_ONLY) {
        throw new AnkiError(
          "READ_ONLY_MODE",
          "Server is running with READ_ONLY=true; restart with READ_ONLY=false to submit ratings",
        );
      }
      const ease = requireEase(args["ease"]);
      const card = await getCurrentCardOrNull();
      if (card === null) {
        throw new AnkiError(
          "REVIEW_NOT_ACTIVE",
          "No card is currently shown in Anki's review window",
        );
      }
      if (lastShownCardId !== card.cardId) {
        throw new AnkiError(
          "INVALID_STATE",
          `show_answer was not called for card ${card.cardId}; call show_answer first`,
        );
      }
      const answered = await invoke<boolean>("guiAnswerCard", { ease }).catch(remapInactiveReview);
      lastShownCardId = null;
      return ok({ answered, cardId: card.cardId, ease });
    }

    case "find_cards": {
      const query = requireString(args["query"], "query");
      const cardIds = await invoke<number[]>("findCards", { query });
      return ok({ cardIds });
    }

    case "card_details": {
      const cardIds = requireCardIds(args["cardIds"]);
      const cards = await invoke<CardInfo[]>("cardsInfo", { cards: cardIds });
      const stripped = cards.map((c) => ({
        ...c,
        question: stripPresentationHtml(c.question),
        answer: stripPresentationHtml(c.answer),
      }));
      return ok({ cards: stripped });
    }

    default:
      throw new AnkiError("INVALID_INPUT", `Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "anki-claude", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ ...t })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await handleCall(req);
  } catch (e) {
    if (e instanceof AnkiError) return err(e.code, e.message);
    const message = e instanceof Error ? e.message : String(e);
    return err("ANKI_ERROR", message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
