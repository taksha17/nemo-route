import type { Complexity, OrchestratePlan, SubtaskPlan, TaskType } from "@nemo-route/shared";
import { nanoid } from "nanoid";
import type { NimClient } from "../upstream/nimClient.js";
import { analyzeRequest, flattenMessages } from "./analyzer.js";
import { executeChat } from "./executor.js";
import { selectFallbackChain } from "./selector.js";

function heuristicPlan(prompt: string): OrchestratePlan {
  const paragraphs = prompt
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1) {
    const analysis = analyzeRequest({
      messages: [{ role: "user", content: prompt }],
      requestedModel: "nemo/auto",
    });
    return {
      subtasks: [
        {
          id: "t1",
          prompt,
          taskType: analysis.taskType,
          complexity: analysis.complexity,
          dependsOn: [],
        },
      ],
      synthesisPrompt: "Return the subtask result as the final answer.",
    };
  }

  const subtasks: SubtaskPlan[] = paragraphs.slice(0, 5).map((p, i) => {
    const analysis = analyzeRequest({
      messages: [{ role: "user", content: p }],
      requestedModel: "nemo/auto",
    });
    return {
      id: `t${i + 1}`,
      prompt: p,
      taskType: analysis.taskType,
      complexity: analysis.complexity,
      dependsOn: i === 0 ? [] : [`t${i}`],
    };
  });

  return {
    subtasks,
    synthesisPrompt:
      "Merge the subtask results into one coherent final answer. Preserve important details.",
  };
}

export async function planOrchestration(
  prompt: string,
  client: NimClient | null,
): Promise<OrchestratePlan> {
  // Prefer heuristic to save RPM; optional LLM planner when a light model is free
  if (!client) return heuristicPlan(prompt);

  const analysis = analyzeRequest({
    messages: [{ role: "user", content: prompt }],
    requestedModel: "nemo/fast",
  });
  const chain = selectFallbackChain({
    analysis: { ...analysis, complexity: "low", taskType: "chat" },
    requestedModel: "nemo/fast",
  });
  const plannerModel = chain[0];
  if (!plannerModel) return heuristicPlan(prompt);

  try {
    const res = await client.chatCompletions(
      {
        model: plannerModel,
        messages: [
          {
            role: "system",
            content:
              'Break the user request into 1-5 ordered subtasks. Reply with JSON only: {"subtasks":[{"id":"t1","prompt":"...","taskType":"chat|code|reasoning|summarize|rewrite|extract|vision|other","complexity":"low|medium|high","dependsOn":[]}],"synthesisPrompt":"..."}',
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
        temperature: 0,
        stream: false,
      },
      "orchestrate",
    );
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return heuristicPlan(prompt);
    const parsed = JSON.parse(match[0]) as OrchestratePlan;
    if (!parsed.subtasks?.length) return heuristicPlan(prompt);
    return {
      subtasks: parsed.subtasks.map((s, i) => ({
        id: s.id || `t${i + 1}`,
        prompt: s.prompt,
        taskType: (s.taskType as TaskType) || "chat",
        complexity: (s.complexity as Complexity) || "medium",
        dependsOn: s.dependsOn ?? [],
      })),
      synthesisPrompt:
        parsed.synthesisPrompt ||
        "Merge the subtask results into one coherent final answer.",
    };
  } catch {
    return heuristicPlan(prompt);
  }
}

export async function runOrchestration(opts: {
  client: NimClient;
  prompt: string;
  stream: boolean;
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
}): Promise<{ content: string; modelsUsed: string[] }> {
  const plan = await planOrchestration(opts.prompt, opts.client);
  opts.onProgress?.({ type: "plan", plan });

  const results = new Map<string, string>();
  const modelsUsed: string[] = [];
  const remaining = new Set(plan.subtasks.map((s) => s.id));

  while (remaining.size > 0) {
    const ready = plan.subtasks.filter(
      (s) =>
        remaining.has(s.id) && s.dependsOn.every((d) => results.has(d)),
    );
    if (ready.length === 0) break;

    await Promise.all(
      ready.map(async (sub) => {
        const depContext = sub.dependsOn
          .map((d) => `### ${d}\n${results.get(d)}`)
          .join("\n\n");
        const prompt = depContext
          ? `${sub.prompt}\n\nContext from prior subtasks:\n${depContext}`
          : sub.prompt;
        opts.onProgress?.({ type: "subtask_start", id: sub.id });
        const analysis = {
          taskType: sub.taskType,
          complexity: sub.complexity,
          requiresTools: false,
          requiresVision: sub.taskType === "vision",
          estimatedInputTokens: Math.ceil(prompt.length / 4),
          confidence: 1,
          method: "forced" as const,
        };
        const result = await executeChat({
          client: opts.client,
          body: {
            model: "nemo/auto",
            messages: [{ role: "user", content: prompt }],
            stream: false,
            max_tokens: 2048,
          },
          analysis,
          requestedModel: "nemo/auto",
          signal: opts.signal,
        });
        const json = (await result.response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content ?? "";
        results.set(sub.id, content);
        modelsUsed.push(result.chosenModel);
        remaining.delete(sub.id);
        opts.onProgress?.({
          type: "subtask_done",
          id: sub.id,
          model: result.chosenModel,
        });
      }),
    );
  }

  const synthesisInput = plan.subtasks
    .map((s) => `### ${s.id}\n${results.get(s.id) ?? ""}`)
    .join("\n\n");

  opts.onProgress?.({ type: "synthesis_start" });
  const synthAnalysis = analyzeRequest({
    messages: [{ role: "user", content: opts.prompt }],
    requestedModel: "nemo/auto",
  });
  const synth = await executeChat({
    client: opts.client,
    body: {
      model: "nemo/auto",
      messages: [
        { role: "system", content: plan.synthesisPrompt },
        {
          role: "user",
          content: `Original request:\n${opts.prompt}\n\nSubtask results:\n${synthesisInput}`,
        },
      ],
      stream: false,
      max_tokens: 4096,
    },
    analysis: synthAnalysis,
    requestedModel: "nemo/auto",
    signal: opts.signal,
  });
  const synthJson = (await synth.response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = synthJson.choices?.[0]?.message?.content ?? "";
  modelsUsed.push(synth.chosenModel);
  opts.onProgress?.({ type: "synthesis_done", model: synth.chosenModel });

  return { content, modelsUsed };
}

export function sessionIdFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const seed = flattenMessages(messages.slice(0, 2)).slice(0, 200);
  return `sess_${nanoid(8)}_${Buffer.from(seed).toString("base64url").slice(0, 16)}`;
}
