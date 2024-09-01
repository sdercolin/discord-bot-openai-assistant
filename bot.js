require('dotenv').config();
const {Client, Events, GatewayIntentBits} = require('discord.js');
const OpenAI = require("openai");
const apiKey = process.env.OPENAI_API_KEY;
const projectId = process.env.OPENAI_PROJECT_ID;
console.log(`Loaded OpenAI API key ${apiKey}`);
const openai = new OpenAI(
    {
        apiKey: apiKey,
        projectId: projectId
    }
);

// save the mapping from discord thread id to openai thread id
const threadMap = new Map();

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
            cleanupThreads(client)
        }, 3600000);
    });

    client.on('messageCreate', async (triggerMessage) => {
        try {
            const requestId = triggerMessage.id;
            if (triggerMessage.author.bot) return;
            // if the message is in the channel, not a thread, only respond when this bot is mentioned, create a thread with
            // default name and start the conversation with the original message
            let openAiThread;
            let discordThread;
            if (!triggerMessage.channel.isThread()) {
                if (!triggerMessage.mentions.has(client.user.id)) return;
                discordThread = await triggerMessage.startThread({name: triggerMessage.content.substring(22)});
                openAiThread = await openai.beta.threads.create({
                    messages: [{role: "user", content: triggerMessage.content}],
                    tool_resources: {
                        "file_search": {
                            "vector_store_ids": [process.env.OPENAI_VECTOR_STORE_ID]
                        }
                    }
                });
                threadMap.set(discordThread.id, openAiThread.id);
                lastActiveTime.set(discordThread.id, Date.now());
                console.log(`${requestId} >>> Created OpenAI thread ${openAiThread.id} for message ${triggerMessage.id} with user ${triggerMessage.author.id}`);
            } else {
                // if the message is in a thread, respond to the message in the thread
                discordThread = triggerMessage.channel;
                const openAiThreadId = threadMap.get(discordThread.id);
                if (!openAiThreadId) {
                    console.log(`${requestId} >>> No OpenAI thread found for Discord thread ${discordThread.id}`);
                    return;
                }
                openAiThread = await openai.beta.threads.retrieve(openAiThreadId);
                if (!openAiThread) {
                    console.log(`${requestId} >>> OpenAI thread ${openAiThreadId} not found`);
                    return;
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
                await openai.beta.threads.messages.create(
                    openAiThreadId,
                    {
                        role: "user",
                        content: triggerMessage.content
                    }
                );
                console.log(`${requestId} >>> Continuing OpenAI thread ${openAiThreadId} with message ${triggerMessage.id} from user ${triggerMessage.author.id}`);
            }

            // create a placeholder message in the thread

            const newMessage = await discordThread.send("Please wait while I process your request...");

            // continue the conversation
            let run = await openai.beta.threads.runs.create(openAiThread.id, {assistant_id: assistant.id});
            console.log(`${requestId} >>> Created OpenAI run ${run.id} in thread ${openAiThread.id}`);
            currentRunMap.set(discordThread.id, {runId: run.id, messageId: newMessage.id});
            let finishedRun = await openai.beta.threads.runs.poll(openAiThread.id, run.id);
            if (finishedRun.status === 'completed') {
                console.log(`${requestId} >>> Completed OpenAI run ${run.id} in thread ${openAiThread.id}`);
                currentRunMap.delete(discordThread.id);
                const messages = await openai.beta.threads.messages.list(run.thread_id);
                for (const message of messages.data.reverse()) {
                    const handledMessageIdSet = handledMessageIds.get(discordThread.id) || new Set();
                    if (message.role === 'assistant' && !handledMessageIdSet.has(message.id)) {
                        handledMessageIdSet.add(message.id);
                        console.log(`${requestId} >>> Handling OpenAI message ${message.id} in thread ${openAiThread.id}`);
                        for (const block of message.content) {
                            if (block.type === 'text') {
                                await newMessage.edit(block.text.value);
                                console.log(`${requestId} >>> Sent text message ${message.id} to thread ${discordThread.id}`);
                            }
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

function cleanupThreads(client) {
    const oneDayMs = 24 * 60 * 60 * 1000; // 86400000 milliseconds in a day
    const now = Date.now();
    lastActiveTime.forEach(async (lastActive, threadId) => {
        if (now - lastActive > oneDayMs) {
            try {
                const thread = await client.channels.fetch(threadId);
                if (thread && thread.isThread()) {
                    // post a message in the thread and archive it
                    await thread.send('This conversation has been archived due to inactivity. Please start a new thread if you need further assistance.')
                    await thread.setArchived(true, 'No activity for one day');
                    console.log(`Archived thread ${threadId} due to inactivity.`);
                }
                // Clear related data
                const openAiThreadId = threadMap.get(threadId);
                threadMap.delete(threadId);
                lastActiveTime.delete(threadId);
                handledMessageIds.delete(threadId);
                currentRunMap.delete(threadId);
                await openai.beta.threads.del(openAiThreadId)
                console.log(`Deleted OpenAI thread ${openAiThreadId} related to Discord thread ${threadId}`);
            } catch (e) {
                console.error(e)
            }
        }
    });
}

main();
