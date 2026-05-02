# anki-claude

Minimal MCP server wrapping AnkiConnect. Stdio transport, spawned by Claude Desktop.

## Build

```sh
npm install --ignore-scripts
npm run build
```

Produces `dist/server.js`.

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "anki": {
      "command": "node",
      "args": ["/Users/natalielam/Projects/anki-claude/dist/server.js"],
      "env": {
        "ANKICONNECT_API_KEY": "...",
        "READ_ONLY": "true"
      }
    }
  }
}
```

Restart Claude Desktop. Set `READ_ONLY` to `"false"` to allow `answer_card`.

## Tools

`list_decks`, `start_review`, `current_card`, `show_answer`, `answer_card`, `find_cards`, `card_details`.

## Error codes

`ANKI_NOT_RUNNING`, `ANKI_AUTH_FAILED`, `ANKI_TIMEOUT`, `REVIEW_NOT_ACTIVE`, `INVALID_STATE`, `READ_ONLY_MODE`, `ANKI_ERROR`, `INVALID_INPUT`.
