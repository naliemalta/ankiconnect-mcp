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
      "args": ["/Users/<your-username>/Projects/anki-claude/dist/server.js"],
      "env": {
        "ANKICONNECT_API_KEY": "...",
        "READ_ONLY": "true"
      }
    }
  }
}
```

After any rebuild or config edit: `pkill -f anki-claude/dist/server.js`, ⌘Q Claude Desktop, relaunch. Set `READ_ONLY` to `"false"` to allow `answer_card`.

## Tools

`list_decks`, `start_review`, `current_card`, `show_answer`, `answer_card`, `find_cards`, `card_details`.

`current_card` and `card_details` strip `<style>` and `<script>` blocks from card question/answer HTML (Migaku, Yomichan, etc. inject these into every payload).

`current_card` returns `{ done: true }` when no card is up — covers both empty queue and review window closed. `show_answer` and `answer_card` return `REVIEW_NOT_ACTIVE` in that case.

## Error codes

`ANKI_NOT_RUNNING`, `ANKI_AUTH_FAILED`, `ANKI_TIMEOUT`, `REVIEW_NOT_ACTIVE`, `INVALID_STATE`, `READ_ONLY_MODE`, `ANKI_ERROR`, `INVALID_INPUT`.
