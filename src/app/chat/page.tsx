"use client";

import { useChat } from "@ai-sdk/react";
import { useState } from "react";

export default function Chat() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error, stop } = useChat();

  const busy = status === "submitted" || status === "streaming";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-10">
      <div className="flex flex-1 flex-col gap-4">
        {messages.length === 0 && (
          <p className="text-zinc-500">
            Ask something, e.g. &ldquo;What&rsquo;s the weather in Paris?&rdquo;
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`whitespace-pre-wrap rounded-lg px-4 py-2 ${
              message.role === "user"
                ? "self-end bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                : "self-start bg-zinc-100 dark:bg-zinc-900"
            }`}
          >
            {message.parts.map((part, i) => {
              switch (part.type) {
                case "text":
                  return <div key={`${message.id}-${i}`}>{part.text}</div>;
                case "tool-weather":
                  return (
                    <pre
                      key={`${message.id}-${i}`}
                      className="overflow-x-auto font-mono text-xs"
                    >
                      {JSON.stringify(part, null, 2)}
                    </pre>
                  );
                default:
                  return null;
              }
            })}
          </div>
        ))}
        {error && (
          <p className="text-red-600">
            Something went wrong. Check the server logs and your API key.
          </p>
        )}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          className="flex-1 rounded border border-zinc-300 p-2 dark:border-zinc-700 dark:bg-zinc-900"
          value={input}
          placeholder="Say something..."
          onChange={(e) => setInput(e.currentTarget.value)}
        />
        {busy ? (
          <button
            type="button"
            className="rounded border border-zinc-300 px-4 dark:border-zinc-700"
            onClick={() => stop()}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 text-white dark:bg-zinc-100 dark:text-black"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
