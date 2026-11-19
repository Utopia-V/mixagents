// A local stand-in for a Responses API provider. It records every request and
// answers according to a directive in the latest user message, so the real
// Codex App Server can run complete turns without a real provider or key.

import http from "node:http";

const DIRECTIVE = /\[\[mock:([a-z-]+)\]\]/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

function latestUserText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type === "message" && item.role === "user") {
      return textOf(item.content);
    }
  }
  return "";
}

function functionOutputs(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.filter((item) => item?.type === "function_call_output");
}

function toolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.map((tool) => tool?.name ?? tool?.type).filter(Boolean);
}

function event(response, payload) {
  response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const usage = {
  input_tokens: 1,
  input_tokens_details: null,
  output_tokens: 1,
  output_tokens_details: null,
  total_tokens: 2,
};

function finish(response, id, items) {
  event(response, { type: "response.created", response: { id } });
  items.forEach((item, index) => {
    event(response, { type: "response.output_item.done", output_index: index, item });
  });
  event(response, { type: "response.completed", response: { id, usage } });
  response.end();
}

function message(id, text) {
  return {
    type: "message",
    role: "assistant",
    id,
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

// The call that prints the environment through the shell tool a Codex build
// exposes, or undefined when it exposes none we know. The call asks for
// unsandboxed execution when the tool allows it: Codex's Linux sandbox cannot
// start where unprivileged user namespaces are restricted (Ubuntu 24.04 and
// GitHub's ubuntu-latest), and the credential filter is applied to the
// command environment either way. The escalation reaches the test as an
// approval request, which it accepts.
function shellCall(tools, callId) {
  const byName = new Map(
    (Array.isArray(tools) ? tools : []).filter((tool) => tool?.name).map((tool) => [tool.name, tool]),
  );
  const escalation = (tool) => {
    const option = tool.parameters?.properties?.sandbox_permissions;
    return Array.isArray(option?.enum) && option.enum.includes("require_escalated")
      ? { sandbox_permissions: "require_escalated", justification: "Broker credential-filter check" }
      : {};
  };
  if (byName.has("exec_command")) {
    return {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: JSON.stringify({ cmd: "env", yield_time_ms: 5000, ...escalation(byName.get("exec_command")) }),
    };
  }
  if (byName.has("shell_command")) {
    return {
      type: "function_call",
      name: "shell_command",
      call_id: callId,
      arguments: JSON.stringify({ command: "env", ...escalation(byName.get("shell_command")) }),
    };
  }
  return undefined;
}

export async function startMockProvider() {
  const requests = [];
  const held = new Set();
  let counter = 0;
  const waiters = new Set();

  const server = http.createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const record = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        rawBody: raw,
        body,
        userText: latestUserText(body),
        tools: toolNames(body),
        functionOutputs: functionOutputs(body),
      };
      requests.push(record);
      for (const waiter of waiters) waiter();

      if (request.method !== "POST" || !request.url.endsWith("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not mocked" } }));
        return;
      }
      counter += 1;
      const id = `resp_mock_${counter}`;
      const directive = DIRECTIVE.exec(record.userText)?.[1] ?? "echo";
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      if (directive === "fail") {
        event(response, { type: "response.created", response: { id } });
        event(response, {
          type: "response.failed",
          response: {
            id,
            status: "failed",
            error: { code: "invalid_prompt", message: "mock provider failure" },
          },
        });
        response.end();
        return;
      }
      if (directive === "hold") {
        // Stay open until the client goes away or the mock stops.
        event(response, { type: "response.created", response: { id } });
        held.add(response);
        response.on("close", () => held.delete(response));
        return;
      }
      if (directive === "env") {
        if (record.functionOutputs.length === 0) {
          const call = shellCall(body?.tools, `call_env_${counter}`);
          if (call) {
            finish(response, id, [call]);
            return;
          }
          finish(response, id, [message(`msg_${counter}`, "mock: no shell tool")]);
          return;
        }
        finish(response, id, [message(`msg_${counter}`, "mock: environment received")]);
        return;
      }
      const marker = /\[\[reply:([^\]]*)\]\]/.exec(record.userText)?.[1] ?? "ok";
      finish(response, id, [message(`msg_${counter}`, `mock final: ${marker}`)]);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    responseRequests() {
      return requests.filter((record) => record.path.endsWith("/responses"));
    },
    async waitFor(predicate, timeoutMs, description) {
      const deadline = Date.now() + timeoutMs;
      while (!requests.some(predicate)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`mock provider never saw ${description} within ${timeoutMs} ms`);
        }
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.min(remaining, 200));
          function done() {
            clearTimeout(timer);
            waiters.delete(done);
            resolve();
          }
          waiters.add(done);
        });
      }
      return requests.find(predicate);
    },
    async close() {
      for (const response of held) response.destroy();
      held.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
