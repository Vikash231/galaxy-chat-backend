import { describe, expect, it } from "vitest";
import { checkAnswer, WaitpointAnswer, WaitpointRequest } from "./waitpoints";

describe("typed-answer questions", () => {
  const request = WaitpointRequest.parse({ kind: "text", question: "How would you like to crop this image?" });

  it("accepts a written answer and nothing else", () => {
    expect(checkAnswer(request, WaitpointAnswer.parse({ text: "keep the left half" }))).toBeNull();
    expect(checkAnswer(request, WaitpointAnswer.parse({ choice: "Left half" }))).toBe("Write your answer.");
    expect(checkAnswer(request, WaitpointAnswer.parse({ approve: true }))).toBe("Write your answer.");
  });

  it("rejects an empty or too long answer before it is saved", () => {
    expect(WaitpointAnswer.safeParse({ text: "   " }).success).toBe(false);
    expect(WaitpointAnswer.safeParse({ text: "x".repeat(501) }).success).toBe(false);
  });

  it("a choice never answers a typed question, and a typed answer never picks an option", () => {
    const options = WaitpointRequest.parse({ kind: "options", question: "Which?", options: ["A", "B"] });
    expect(checkAnswer(options, WaitpointAnswer.parse({ text: "A" }))).toBe("Pick one of the offered options.");
  });
});
