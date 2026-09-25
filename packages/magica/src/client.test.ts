import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import { createMagicaClient } from "./client";
import { MagicaError } from "./errors";

const BASE = "https://magica.test";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const live = createMagicaClient({ baseUrl: BASE, apiKey: "gx_test", mode: "live", timeoutMs: 200 });

describe("magica client", () => {
  it("starts a run with the bearer key and returns the runId", async () => {
    let auth = "";
    server.use(http.post(`${BASE}/v1/nodes/crop_image/run`, ({ request }) => ((auth = request.headers.get("authorization") ?? ""), HttpResponse.json({ runId: "run_1" }, { status: 202 }))));
    await expect(live.run("crop_image", { input: {} })).resolves.toEqual({ runId: "run_1" });
    expect(auth).toBe("Bearer gx_test");
  });

  it.each([
    [400, "invalid_input", false],
    [401, "unauthorized", false],
    [403, "provider_credits", false],
    [404, "model_unavailable", false],
    [410, "model_unavailable", false],
    [429, "rate_limited", true],
    [500, "provider_error", true],
  ])("maps HTTP %i to %s (retryable=%s)", async (status, code, retryable) => {
    server.use(http.post(`${BASE}/v1/nodes/crop_image/run`, () => HttpResponse.json({ message: "nope", traceId: "req_1" }, { status })));
    const err = await live.run("crop_image", { input: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(MagicaError);
    expect(err).toMatchObject({ code, retryable });
  });

  it("times out slow requests", async () => {
    server.use(http.get(`${BASE}/v1/nodes/runs/run_1`, async () => (await delay(1_000), HttpResponse.json({}))));
    await expect(live.getRun("run_1")).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("validates the run payload and reports credits in microcredits", async () => {
    server.use(http.get(`${BASE}/v1/nodes/runs/run_1`, () => HttpResponse.json({ id: "run_1", nodeType: "crop_image", status: "COMPLETED", output: { image_url: "https://x/y.png" }, creditUsed: 5000 })));
    await expect(live.getRun("run_1")).resolves.toMatchObject({ status: "COMPLETED", creditUsed: 5000 });
  });

  it("only shows Magica's message to users for input errors", () => {
    expect(new MagicaError("invalid_input", 400, "width too large").toSafe().message).toBe("width too large");
    expect(new MagicaError("unauthorized", 401, "bad key gx_123").toSafe().message).not.toContain("gx_");
  });

  it("fixture mode never touches the network and survives a restart between run and getRun", async () => {
    const f = createMagicaClient({ baseUrl: BASE, apiKey: "x", mode: "fixture" });
    const { runId } = await f.run("crop_image", { input: {} });
    const again = createMagicaClient({ baseUrl: BASE, apiKey: "x", mode: "fixture" });
    await expect(again.getRun(runId)).resolves.toMatchObject({ status: "COMPLETED", creditUsed: 5000 });
  });
});
