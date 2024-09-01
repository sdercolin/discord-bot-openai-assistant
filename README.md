# Discord OpenAI Assistant Bot

This project is a Discord bot that integrates with OpenAI's Assistant API to provide conversational AI capabilities.

## Installation

To install the dependencies, run:

```sh
npm install
```

## Configuration

1. Create your Open AI project and assistant
2. Create your Discord bot and get the token. The Discord Bot needs to have access to `Message Content Intent`, and
   proper permissions to read and write messages in channel and threads.
3. Create a `.env` file in the root directory of your project and add the following environment variables:
    ```
    DISCORD_TOKEN=your-discord-bot-token
    OPENAI_API_KEY=your-openai-api-key
    OPENAI_PROJECT_ID=your-openai-project-id
    OPENAI_ASSISTANT_ID=your-openai-assistant-id
    OPENAI_VECTOR_STORE_ID=your-openai-vector-store-id
    ```

## Usage

### Running the Bot

To start the bot, run:

```sh
node bot.js
```

### Bot Functionality

- **Thread Management**: The bot creates a new thread when mentioned in a channel and starts a conversation with the
  initial message.
- **Message Handling**: The bot responds to messages within threads by interacting with OpenAI's API.
- **Cleanup**: The bot archives inactive threads and deletes related OpenAI threads after a period of inactivity.

## Methods

### `main()`

Initializes the Discord client and handles events.

### `cleanupThreads(client)`

Cleans up inactive threads by archiving them and deleting related OpenAI threads.

## Environment Variables

- `DISCORD_TOKEN`: The token for your Discord bot.
- `OPENAI_API_KEY`: The API key for OpenAI.
- `OPENAI_PROJECT_ID`: The project ID for OpenAI.
- `OPENAI_ASSISTANT_ID`: The assistant ID for OpenAI.
- `OPENAI_VECTOR_STORE_ID`: The vector store ID for OpenAI.

## Error Handling

The bot logs errors to the console for various error conditions, such as missing credentials or API errors.

## License

This project is licensed under the MIT License.
