import { z } from "zod";
import { MAX_MEDIA_CHOICES, MAX_OPTIONS, MAX_PLAN_STEPS, type PlanStep } from "@gx/contracts";
import { ToolRunError, type AnyTool, type FileFacts, type FileLookup, type ParsedArgsFn, type ToolDef } from "./types";

type Deps = { getTool(name: string): AnyTool | undefined; parseArgs: ParsedArgsFn };

const KIND = { img: "image", vid: "video", aud: "audio" } as const;

/** Add up what a plan's tool steps would cost. Files a later step will create count as placeholders; unknown lengths count as 60 s. */
export function estimatePlan(steps: PlanStep[], f: FileLookup, deps: Deps): bigint {
  const facts: FileFacts = { durationSec: (url) => f.durations.get(url) };
  let total = 0n;
  steps.forEach((step, i) => {
    if (!step.tool) return;
    const tool = deps.getTool(step.tool);
    if (!tool) throw new ToolRunError(`Step ${i + 1}: there is no tool named "${step.tool}".`);
    if (tool.exec.kind !== "magica") return;
    const parsed = deps.parseArgs(tool, step.args?.trim() || "{}", f.files, f.aliases, { lenient: true });
    if (!parsed.ok) throw new ToolRunError(`Step ${i + 1} (${step.tool}): ${parsed.message}`);
    total += tool.estimateMicro(parsed.args, facts);
  });
  return total;
}

/** Turn whatever a model sent for `steps` into a list of lines: a JSON list, or plain text with one step per line. */
function stepsFromText(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: treat it as plain text below.
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean);
  return lines.length ? lines : [text];
}

/** One step as a model may send it: a bare string, or an object that calls its text something else. */
function coerceStep(step: unknown): unknown {
  if (typeof step === "string") return { text: step.slice(0, 300) };
  if (!step || typeof step !== "object") return step;
  const s = step as Record<string, unknown>;
  const text = [s.text, s.description, s.title, s.name, s.step].find((v) => typeof v === "string" && v.trim());
  return {
    ...(text !== undefined && { text: (text as string).slice(0, 300) }),
    ...(s.tool !== undefined && { tool: s.tool }),
    // The field is a string so file names that do not exist yet are not resolved early.
    ...(s.args !== undefined && { args: typeof s.args === "object" && s.args !== null ? JSON.stringify(s.args) : s.args }),
  };
}

/** Weak models often send steps as text or a list of strings, or leave out the summary; accept those. */
function coercePlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const steps = typeof r.steps === "string" ? stepsFromText(r.steps) : r.steps;
  if (Array.isArray(steps)) r.steps = steps.map(coerceStep);
  if (typeof r.summary !== "string" || !r.summary.trim()) {
    const first = Array.isArray(r.steps) ? (r.steps[0] as { text?: unknown } | undefined)?.text : undefined;
    if (typeof first === "string") r.summary = first;
  }
  return r;
}

/** A list a model sent as text: a JSON list, or items split by new lines or commas. */
function listFromText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = stepsFromText(value);
  if (parsed.length > 1 || value.includes("\n")) return parsed;
  const parts = value.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : parsed;
}

/** ask_user and propose_plan: free tools that pause the run until the user answers. */
export function interactionTools(deps: Deps): AnyTool[] {
  const askArgs = z.object({
    question: z.string().min(1).max(300).describe("A short question."),
    options: z.array(z.string().min(1).max(120)).min(2).max(MAX_OPTIONS).optional().describe("2 to 6 short choices."),
    files: z.array(z.string()).min(1).max(MAX_MEDIA_CHOICES).optional().describe("File names to choose from, e.g. img_1. Use instead of options when the user should pick a file."),
  });
  const askOutput = z.object({ status: z.enum(["answered", "expired", "cancelled"]), choice: z.string().optional() });
  const askUser: ToolDef<typeof askArgs, z.infer<typeof askOutput>> = {
    name: "ask_user",
    description: "Ask the user to pick one of several options, or one of several files, when a wrong guess would waste credits. Free. Give options or files, not both. Waits for the answer.",
    label: "Waiting for your answer",
    args: askArgs,
    output: askOutput,
    interactive: true,
    normalize: (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const r = raw as Record<string, unknown>;
      return { ...r, ...(r.options !== undefined && { options: listFromText(r.options) }), ...(r.files !== undefined && { files: listFromText(r.files) }) };
    },
    estimateMicro: () => 0n,
    assets: () => [],
    endsTurn: (o) => (o.status === "answered" ? undefined : "I didn't get an answer, so I stopped here. Send a message when you're ready to continue."),
    exec: {
      kind: "local",
      run: async (a, ctx) => {
        if (!!a.options === !!a.files) throw new ToolRunError("Give either options or files, not both and not neither.");
        let request;
        if (a.options) request = { kind: "options" as const, question: a.question, options: a.options };
        else {
          // Names were swapped for URLs while the arguments were checked; swap back so the answer is a name.
          const nameOf = new Map([...ctx.files.files].map(([n, u]) => [u, n]));
          const files = a.files!.map((url) => ({ name: nameOf.get(url) ?? url, url, kind: KIND[(nameOf.get(url) ?? "img_").split("_")[0] as keyof typeof KIND] ?? "image" }));
          request = { kind: "media" as const, question: a.question, files };
        }
        const res = await ctx.ask(request);
        if (res.status === "answered" && "choice" in res.answer) return { status: "answered" as const, choice: res.answer.choice };
        return { status: res.status === "answered" ? ("cancelled" as const) : res.status };
      },
    },
  };

  const planArgs = z.object({
    summary: z.string().min(1).max(500).describe("What you will do, in one or two sentences."),
    steps: z
      .array(
        z.object({
          text: z.string().min(1).max(300).describe("One step in plain words."),
          tool: z.string().max(60).optional().describe("The tool this step calls, if any."),
          args: z.string().max(4000).optional().describe("That tool's arguments as a JSON string. Use names like img_1 for files; a file a previous step will create may be named img_N for the next number."),
        }),
      )
      .min(1)
      .max(MAX_PLAN_STEPS),
  });
  const planOutput = z.object({
    status: z.enum(["approved", "declined", "expired", "cancelled"]),
    estimateMicro: z.number().int().nonnegative(),
    note: z.string().optional(),
    // Spoken to the model: what to do next, and that a note from the user changes the plan.
    instruction: z.string().optional(),
  });
  const proposePlan: ToolDef<typeof planArgs, z.infer<typeof planOutput>> = {
    name: "propose_plan",
    description:
      'Only when the instructions say PLAN MODE is on: show the user a plan and wait for approval before any tool that costs credits. Give tool and args for every step that uses a tool, so the cost can be shown. Free. Waits for the answer. Example: {"summary":"Make one fox image","steps":[{"text":"Generate the image","tool":"gpt_image_2","args":{"prompt":"a red fox"}}]}',
    label: "Waiting for plan approval",
    args: planArgs,
    output: planOutput,
    interactive: true,
    normalize: coercePlan,
    estimateMicro: () => 0n,
    assets: () => [],
    endsTurn: (o) =>
      o.status === "approved"
        ? undefined
        : o.status === "declined"
          ? `Plan cancelled. Nothing was spent.${o.note ? ` (${o.note})` : ""} Tell me what to change, or send a new message.`
          : "The plan wasn't answered in time, so I stopped. Nothing was spent. Send a message to continue.",
    exec: {
      kind: "local",
      run: async (a, ctx) => {
        const estimate = Number(estimatePlan(a.steps, ctx.files, deps));
        const res = await ctx.ask({ kind: "plan", summary: a.summary, steps: a.steps, estimateMicro: estimate });
        if (res.status !== "answered" || !("approve" in res.answer)) return { status: res.status === "answered" ? ("cancelled" as const) : res.status, estimateMicro: estimate };
        const { approve, note } = res.answer;
        if (!approve) return { status: "declined" as const, estimateMicro: estimate, ...(note && { note }) };
        return {
          status: "approved" as const,
          estimateMicro: estimate,
          ...(note && { note }),
          instruction: note
            ? `The user approved the plan and added this instruction, which changes it: "${note}". Apply it to the tool arguments (for example, put it into the prompt), then carry out the plan now.`
            : "The user approved the plan. Carry it out now.",
        };
      },
    },
  };

  return [askUser, proposePlan];
}
