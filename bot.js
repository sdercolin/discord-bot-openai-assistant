require('dotenv').config();
const {Client, Events, GatewayIntentBits} = require('discord.js');
const OpenAI = require("openai");
const apiKey = process.env.OPENAI_API_KEY;
const projectId = process.env.OPENAI_PROJECT_ID;
const maxMessagesReplays = process.env.MAX_MESSAGES_REPLAYS ? parseInt(process.env.MAX_MESSAGES_REPLAYS) : 30;
const defaultLanguage = process.env.DEFAULT_LANGUAGE ?? 'en';
console.log(`Loaded OpenAI API key ${apiKey}`);
const openai = new OpenAI(
    {
        apiKey: apiKey,
        projectId: projectId
    }
);

// save the mapping from discord thread id to openai thread id
const threadMap = new Map();

// maintain the last tracked message id with key as discord thread id
const lastTrackedMessageId = new Map();

// maintain the set of OpenAI message ids that have been handled with key as discord thread id
const handledMessageIds = new Map();

// save the mapping from discord thread id to the current run id and placeholder message id
// {discordThreadId: {runId: openaiRunId, messageId: discordMessageId}}
const currentRunMap = new Map();

// Maps discordThreadId to the last active timestamp
const lastActiveTime = new Map();

async function main() {
    const assistant = await openai.beta.assistants.retrieve(process.env.OPENAI_ASSISTANT_ID);
    console.log(`Loaded assistant ${assistant.id}`);
    const client = new Client({intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]});

    client.once(Events.ClientReady, readyClient => {
        console.log(`Ready! Discord logged in as ${readyClient.user.tag}`);
        setInterval(() => {
            cleanupThreads()
        }, 3600000);
    });

    client.on('messageCreate', async (triggerMessage) => {
        try {
            const requestId = triggerMessage.id;
            if (triggerMessage.author.bot) return;
            if (!triggerMessage.mentions.has(client.user.id)) return;
            // if the message is in the channel, not a thread, create a thread with a default name and start
            // the conversation with the original message
            let openAiThread = null;
            let discordThread;
            if (!triggerMessage.channel.isThread()) {
                discordThread = await triggerMessage.startThread({name: triggerMessage.content.substring(22)});
                openAiThread = await createOpenAiThread(openai, [triggerMessage]);
                threadMap.set(discordThread.id, openAiThread.id);
                lastTrackedMessageId.set(discordThread.id, triggerMessage.id);
                lastActiveTime.set(discordThread.id, Date.now());
                console.log(`${requestId} >>> Created OpenAI thread ${openAiThread.id} for message ${triggerMessage.id} with user ${triggerMessage.author.id}`);
            } else {
                // if the message is in a thread, respond to the message in the thread
                discordThread = triggerMessage.channel;
                const openAiThreadId = threadMap.get(discordThread.id);

                if (!openAiThreadId) {
                    console.log(`${requestId} >>> No OpenAI thread found for Discord thread ${discordThread.id}`);
                } else {
                    openAiThread = await openai.beta.threads.retrieve(openAiThreadId);
                    if (!openAiThread) {
                        console.log(`${requestId} >>> OpenAI thread ${openAiThreadId} not found`);
                    }
                }
                let isNewThread = false
                if (!openAiThread) {
                    const discordMessages = await discordThread.messages.fetch({limit: maxMessagesReplays});
                    openAiThread = await createOpenAiThread(openai, discordMessages);
                    isNewThread = true;
                    threadMap.set(discordThread.id, openAiThread.id);
                    const latest = discordMessages.first()
                    if (latest) {
                        lastTrackedMessageId.set(discordThread.id, latest.id);
                    }
                    console.log(`${requestId} >>> Created OpenAI thread ${openAiThread.id} for Discord thread ${discordThread.id} with ${discordMessages.size} messages`);
                }

                lastActiveTime.set(discordThread.id, Date.now());
                const currentRunContext = currentRunMap.get(discordThread.id);
                if (currentRunContext) {
                    console.log(`${requestId} >>> Cancelling ongoing OpenAI run ${currentRunContext.runId} in thread ${openAiThreadId}`);
                    const {runId: ongoingRunId, messageId: ongoingMessageId} = currentRunContext;
                    const ongoingRun = await openai.beta.threads.runs.retrieve(openAiThreadId, ongoingRunId);
                    if (ongoingRun && ongoingRun.status === 'in_progress') {
                        await openai.beta.threads.runs.cancel(openAiThreadId, ongoingRunId);
                        await discordThread.messages.fetch(ongoingMessageId).then(message => message.delete());
                    }
                }
                if (!isNewThread) {
                    const untrackedMessages = await discordThread.messages.fetch({
                        limit: maxMessagesReplays,
                        after: lastTrackedMessageId.get(discordThread.id)
                    });
                    if (untrackedMessages.size > 1) {
                        console.log(`${requestId} >>> Found ${untrackedMessages.size - 1} untracked messages in Discord thread ${discordThread.id}`);
                    }
                    let triggerMessageHandled = false
                    let count = 0
                    for (let i = 0; i < untrackedMessages.size; i++) {
                        const message = untrackedMessages.at(untrackedMessages.size - i - 1);
                        await openai.beta.threads.messages.create(
                            openAiThreadId,
                            convertMessage(message)
                        );
                        count++
                        if (!triggerMessageHandled && message.id === triggerMessage.id) {
                            triggerMessageHandled = true
                        }
                    }
                    if (!triggerMessageHandled) {
                        await openai.beta.threads.messages.create(
                            openAiThreadId,
                            convertMessage(triggerMessage)
                        );
                        count++
                        lastTrackedMessageId.set(discordThread.id, triggerMessage.id);
                    } else {
                        lastTrackedMessageId.set(discordThread.id, untrackedMessages.first().id);
                    }
                    if (count > 1) {
                        console.log(`${requestId} >>> Added ${count - 1} untracked messages to OpenAI thread ${openAiThreadId}`);
                    }
                    console.log(`${requestId} >>> Continuing OpenAI thread ${openAiThreadId} with message ${triggerMessage.id}`);
                }
            }

            // create a placeholder message in the thread
            const placeholder = defaultLanguage === 'ja' ? "リクエストを処理中です。お待ちください..."
                : "Please wait while I process your request...";
            const newMessage = await discordThread.send(placeholder);
            lastTrackedMessageId.set(discordThread.id, newMessage.id);

            // continue the conversation
            let run = await openai.beta.threads.runs.create(openAiThread.id, {assistant_id: assistant.id});
            console.log(`${requestId} >>> Created OpenAI run ${run.id} in thread ${openAiThread.id}`);
            currentRunMap.set(discordThread.id, {runId: run.id, messageId: newMessage.id});
            let finishedRun = await openai.beta.threads.runs.poll(openAiThread.id, run.id);
            if (finishedRun.status === 'completed') {
                console.log(`${requestId} >>> Completed OpenAI run ${run.id} in thread ${openAiThread.id}`);
                currentRunMap.delete(discordThread.id);
                const messages = await openai.beta.threads.messages.list(run.thread_id);
                let handledMessageIdSet = handledMessageIds.get(discordThread.id)
                if (!handledMessageIdSet) {
                    handledMessageIdSet = new Set();
                    handledMessageIds.set(discordThread.id, handledMessageIdSet);
                }
                const messageDataList = messages.data.filter(message => message.role === 'assistant' && !handledMessageIdSet.has(message.id))
                if (messageDataList.length > 0) {
                    const message = messageDataList[0];
                    handledMessageIdSet.add(message.id);
                    console.log(`${requestId} >>> Handling OpenAI message ${message.id} in thread ${openAiThread.id}`);
                    for (const block of message.content) {
                        if (block.type === 'text') {
                            let newMessageText = await buildMessageContent(openai, block.text);
                            await newMessage.edit(newMessageText);
                            lastTrackedMessageId.set(discordThread.id, newMessage.id);
                            console.log(`${requestId} >>> Sent text message ${message.id} to thread ${discordThread.id}`);
                            break
                        }
                    }
                }
            } else {
                console.log(`${requestId} >>> OpenAI run ${run.id} in thread ${openAiThread.id} is ${run.status}`);
            }
        } catch (e) {
            console.error(e)
        }
    });

    await client.login(process.env.DISCORD_TOKEN);
    console.log("Logged in to Discord");
}

async function cleanupThreads() {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [threadId, lastActive] of lastActiveTime.entries()) {
        if (now - lastActive > oneDayMs) {
            try {
                const openAiThreadId = threadMap.get(threadId);
                if (openAiThreadId) {
                    await openai.beta.threads.del(openAiThreadId);
                }
                threadMap.delete(threadId);
                lastActiveTime.delete(threadId);
                handledMessageIds.delete(threadId);
                currentRunMap.delete(threadId);
                console.log(`Cleaned up resources for thread ${threadId}`);
            } catch (e) {
                console.error(`Failed to clean up thread ${threadId}: ${e}`);
            }
        }
    }
}

function convertMessage(discordMessage) {
    const role = discordMessage.author.bot ? "assistant" : "user";
    return {role: role, content: `${discordMessage.author.username}: ${discordMessage.content}`};
}

function createOpenAiThread(openai, discordMessages) {
    return openai.beta.threads.create({
        messages: discordMessages.map((message) => convertMessage(message)).reverse(),
        tool_resources: {
            "file_search": {
                "vector_store_ids": [process.env.OPENAI_VECTOR_STORE_ID]
            }
        }
    });
}

async function buildMessageContent(openai, openaiMessage) {
    let text = openaiMessage.value
    let citations = []
    console.log("building message content: " + JSON.stringify(openaiMessage))
    for (let i in openaiMessage.annotations) {
        let index = parseInt(i)
        const annotation = openaiMessage.annotations[index]
        if (annotation.type === 'file_citation') {
            text = text.replace(annotation.text, `[${index + 1}]`)
            if (annotation.file_citation) {
                let file = await openai.files.retrieve(annotation.file_citation.file_id)
                console.log("file citation: " + JSON.stringify(file))
                citations.push(`[${index + 1}]: ${file.filename}`)
            }
        }
    }
    let result = text
    if (citations.length > 0) {
        result += "\n\nSources: \n" + citations.join("\n")
    }
    return result
}

main();
