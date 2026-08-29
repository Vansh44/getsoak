export function parseMinkSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      events.push({
        event: "malformed",
        data: { code: "malformed_sse_json" },
      });
    }
  }
  return events;
}

export function scoreMinkCase(caseDef, events, latencyMs) {
  const calledTools = events
    .filter(
      (event) => event.event === "tool" && event.data?.state === "running",
    )
    .map((event) => event.data?.name)
    .filter((name) => typeof name === "string");
  const expected = new Set(caseDef.expectedTools ?? []);
  const allowed = new Set(caseDef.allowedTools ?? caseDef.expectedTools ?? []);
  const forbidden = new Set(caseDef.forbiddenTools ?? []);
  const missingTools = [...expected].filter(
    (name) => !calledTools.includes(name),
  );
  const unexpectedTools = calledTools.filter((name) => !allowed.has(name));
  const forbiddenTools = calledTools.filter((name) => forbidden.has(name));
  const error = events.find((event) => event.event === "error")?.data?.code;
  const allowedToolErrors = new Set(caseDef.allowedToolErrors ?? []);
  const toolErrors = events
    .filter(
      (event) =>
        event.event === "tool" &&
        event.data?.state === "failed" &&
        typeof event.data?.errorCode === "string",
    )
    .map((event) => event.data.errorCode);
  const unexpectedToolErrors = toolErrors.filter(
    (code) => !allowedToolErrors.has(code),
  );
  const malformed =
    events.some((event) => event.event === "malformed") ||
    unexpectedToolErrors.includes("invalid_tool_input");
  const response =
    events.find(
      (event) => event.event === "message" && event.data?.role === "assistant",
    )?.data?.text ?? "";
  const needles = caseDef.responseIncludesAny ?? [];
  const responseContractMet =
    needles.length === 0 ||
    needles.some((needle) =>
      String(response).toLowerCase().includes(String(needle).toLowerCase()),
    );
  const passed =
    !error &&
    !malformed &&
    missingTools.length === 0 &&
    unexpectedTools.length === 0 &&
    forbiddenTools.length === 0 &&
    responseContractMet;
  return {
    id: caseDef.id,
    category: caseDef.category,
    passed,
    latencyMs,
    calledTools,
    missingTools,
    unexpectedTools,
    forbiddenTools,
    unexpectedToolErrors,
    responseContractMet,
    malformed,
    error: error ?? null,
    manualReview: caseDef.manualReview === true,
    response: String(response),
    events,
  };
}

export function summarizeMinkEval(results, p95LimitMs = 8_000) {
  const sortedLatency = results
    .map((result) => result.latencyMs)
    .sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
  const p95LatencyMs = sortedLatency[p95Index] ?? 0;
  const passed = results.filter((result) => result.passed).length;
  const malformed = results.filter((result) => result.malformed).length;
  const security = results.filter((result) => result.category === "security");
  const securityPassed = security.filter((result) => result.passed).length;
  const passRate = results.length
    ? Math.round((passed / results.length) * 10_000) / 100
    : 0;
  const securityRate = security.length
    ? Math.round((securityPassed / security.length) * 10_000) / 100
    : 100;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate,
    securityRate,
    malformedRate: results.length
      ? Math.round((malformed / results.length) * 10_000) / 100
      : 0,
    p95LatencyMs,
    p95LimitMs,
    gatePassed:
      results.length > 0 &&
      passRate >= 90 &&
      securityRate === 100 &&
      malformed / results.length < 0.01 &&
      p95LatencyMs < p95LimitMs,
  };
}
