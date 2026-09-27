import type { LlmMessage, LlmProvider, StepResult } from "./types";

const step = (over: Partial<StepResult>): StepResult => ({
  text: "",
  thinking: "",
  toolCalls: [],
  model: "scripted",
  usage: { promptTokens: 0, completionTokens: 0 },
  finishReason: "stop",
  ...over,
});

const call = (name: string, args: object) => ({ id: `s_${name}`, name, argsJson: JSON.stringify(args) });

/**
 * A local stand-in for the model, chosen by a tag in the user's message: [ask], [plan], [low], [pay].
 * It never calls a tool that spends credits by itself, so the approval flows can be tried with no model and no cost.
 * Enabled with LLM_FIXTURE=scripted; never used unless that is set.
 */
export function createScriptedProvider(): LlmProvider {
  return {
    async streamStep({ messages, tools }, onDelta) {
      const last: LlmMessage | undefined = messages.at(-1);
      const say = (text: string) => (onDelta({ type: "text", delta: text }), step({ text }));
      // A call with no tools is the chat summariser.
      if (!tools.length) return say(`Scripted summary of ${String(last?.content ?? "").split("\n").length} lines.`);

      const lowFox = { prompt: "a red fox", size: "1024x1024", quality: "low" };
      // After an approved plan, carry it out once (the plan's only step), like a model following its plan.
      if (last?.role === "tool" && last.content.includes('"status":"approved"')) {
        // Like a model that follows the approval note: it goes into the prompt.
        const note = (JSON.parse(last.content) as { note?: string }).note;
        return step({ toolCalls: [call("gpt_image_2", { ...lowFox, prompt: note ? `${lowFox.prompt}, ${note}` : lowFox.prompt })] });
      }
      if (last?.role === "tool") return say(`The tool said: ${last.content.slice(0, 200)}`);
      // A retry adds a note as the last user message; the request is the one before it.
      const user = [...messages].reverse().find((m) => m.role === "user" && !m.content.startsWith("The previous reply stopped"))?.content ?? "";

      if (user.includes("[ask]")) return step({ toolCalls: [call("ask_user", { question: "Which colour do you prefer?", options: ["Red", "Blue"] })] });
      if (user.includes("[plan]"))
        return step({
          toolCalls: [call("propose_plan", { summary: "Make one image of a red fox.", steps: [{ text: "Generate the image", tool: "gpt_image_2", args: { prompt: "a red fox", size: "1024x1024", quality: "low" } }] })],
        });
      if (user.includes("[low]")) return step({ toolCalls: [call("gpt_image_2", lowFox)] });
      if (user.includes("[pay]")) return step({ toolCalls: [call("gpt_image_2", { prompt: "a red fox", size: "1024x1024", quality: "high" })] });
      return say("This is the scripted model. Use [ask], [plan], [low] or [pay] in your message.");
    },
  };
}
