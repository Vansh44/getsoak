import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  parseMinkSse,
  scoreMinkCase,
  summarizeMinkEval,
} from "./mink-eval-core.mjs";

const baseUrl = process.env.MINK_EVAL_BASE_URL?.trim();
const cookie = process.env.MINK_EVAL_COOKIE?.trim();
if (!baseUrl || !cookie) {
  console.error(
    "Set MINK_EVAL_BASE_URL and MINK_EVAL_COOKIE for a controlled signed-in internal store.",
  );
  process.exit(2);
}

const datasetPath = fileURLToPath(
  new URL("../evals/mink/read-alpha.json", import.meta.url),
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const limit = boundedInt(
  process.env.MINK_EVAL_CASE_LIMIT,
  dataset.cases.length,
  1,
  dataset.cases.length,
);
const delayMs = boundedInt(process.env.MINK_EVAL_DELAY_MS, 3_200, 0, 60_000);
const p95LimitMs = boundedInt(
  process.env.MINK_EVAL_P95_LIMIT_MS,
  8_000,
  1_000,
  300_000,
);
const requestTimeoutMs = boundedInt(
  process.env.MINK_EVAL_REQUEST_TIMEOUT_MS,
  150_000,
  15_000,
  360_000,
);
const includeResponses = process.env.MINK_EVAL_INCLUDE_RESPONSES === "true";
const endpoint = new URL("/api/mink/stream", baseUrl);
const origin = new URL(baseUrl).origin;
const cases = dataset.cases.slice(0, limit);
const results = [];

if (includeResponses) {
  console.error(
    "Warning: MINK_EVAL_INCLUDE_RESPONSES=true prints model answers, which may contain controlled-store business data.",
  );
}

for (let index = 0; index < cases.length; index += 1) {
  const caseDef = cases[index];
  const startedAt = Date.now();
  let events;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      body: JSON.stringify({ message: caseDef.prompt }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = await response.text();
    events = response.ok
      ? parseMinkSse(body)
      : [
          {
            event: "error",
            data: { code: `http_${response.status}` },
          },
        ];
  } catch (error) {
    events = [
      {
        event: "error",
        data: {
          code:
            error instanceof Error && error.name === "AbortError"
              ? "client_timeout"
              : "network_error",
        },
      },
    ];
  }
  const result = scoreMinkCase(caseDef, events, Date.now() - startedAt);
  results.push(result);
  console.error(
    `[${index + 1}/${cases.length}] ${caseDef.id}: ${result.passed ? "pass" : "FAIL"} (${result.latencyMs}ms)`,
  );
  if (delayMs && index + 1 < cases.length) await delay(delayMs);
}

const summary = summarizeMinkEval(results, p95LimitMs);
const model = results
  .flatMap((result) => result.events)
  .find((event) => event.event === "usage")?.data?.model;
const report = {
  dataset: dataset.version,
  baseOrigin: origin,
  model: typeof model === "string" ? model : null,
  generatedAt: new Date().toISOString(),
  summary,
  results: results.map((result) => {
    const output = { ...result };
    delete output.events;
    if (!includeResponses) delete output.response;
    return output;
  }),
};
console.log(JSON.stringify(report, null, 2));
if (!summary.gatePassed) process.exitCode = 1;

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}
