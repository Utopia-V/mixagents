import { BrokerError } from "./errors.js";
import type { PendingInteraction } from "./types.js";

export type Elicitor = (params: Record<string, unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function elicitationDecision(result: unknown): "approve" | "decline" | "cancel" {
  if (!isRecord(result)) {
    return "cancel";
  }
  if (result.action === "decline") {
    return "decline";
  }
  if (result.action !== "accept" || !isRecord(result.content)) {
    return "cancel";
  }
  return result.content.decision === "approve" ? "approve" : "decline";
}

async function askApproval(
  label: string,
  detail: string,
  elicit: Elicitor | undefined,
): Promise<"approve" | "decline" | "cancel"> {
  if (!elicit) {
    return "decline";
  }
  const result = await elicit({
    mode: "form",
    message: truncate(`${label}\n\n${detail}`),
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Decision",
          enum: ["approve", "decline"],
          enumNames: ["Approve once", "Decline"],
        },
      },
      required: ["decision"],
    },
  });
  return elicitationDecision(result);
}

function commandDetail(params: Record<string, unknown>): string {
  const command = typeof params.command === "string" ? params.command : "Unknown command";
  const cwd = typeof params.cwd === "string" ? params.cwd : "Unknown directory";
  const reason = typeof params.reason === "string" ? params.reason : "No reason supplied";
  return `Command: ${command}\nDirectory: ${cwd}\nReason: ${reason}`;
}

function fileDetail(params: Record<string, unknown>): string {
  const reason = typeof params.reason === "string" ? params.reason : "No reason supplied";
  const root = typeof params.grantRoot === "string" ? `\nRequested root: ${params.grantRoot}` : "";
  return `Reason: ${reason}${root}`;
}

function userInputSchema(
  questions: Record<string, unknown>[],
): { schema: Record<string, unknown>; secret: boolean } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let secret = false;
  for (const question of questions.slice(0, 3)) {
    if (typeof question.id !== "string" || typeof question.question !== "string") {
      continue;
    }
    if (question.isSecret === true) {
      secret = true;
      continue;
    }
    const property: Record<string, unknown> = {
      type: "string",
      title: typeof question.header === "string" ? question.header : question.id,
      description: question.question,
    };
    if (Array.isArray(question.options) && question.isOther !== true) {
      const values = question.options
        .filter(isRecord)
        .map((option) => option.label)
        .filter((label): label is string => typeof label === "string");
      if (values.length > 0) {
        property.enum = values;
      }
    }
    properties[question.id] = property;
    required.push(question.id);
  }
  return {
    schema: { type: "object", properties, required },
    secret,
  };
}

async function answerUserInput(
  params: Record<string, unknown>,
  elicit: Elicitor | undefined,
): Promise<unknown> {
  const questions = Array.isArray(params.questions)
    ? params.questions.filter(isRecord)
    : [];
  const { schema, secret } = userInputSchema(questions);
  if (!elicit || secret || Object.keys(schema.properties as object).length === 0) {
    return { answers: {} };
  }
  const result = await elicit({
    mode: "form",
    message: "A Broker-managed worker needs additional non-secret input.",
    requestedSchema: schema,
  });
  if (!isRecord(result) || result.action !== "accept" || !isRecord(result.content)) {
    return { answers: {} };
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    if (typeof question.id !== "string") {
      continue;
    }
    const value = result.content[question.id];
    if (typeof value === "string") {
      answers[question.id] = { answers: [value] };
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      answers[question.id] = { answers: value };
    }
  }
  return { answers };
}

export async function resolveInteraction(
  interaction: PendingInteraction,
  elicit?: Elicitor,
): Promise<void> {
  const { method, params } = interaction;
  try {
    if (method === "item/commandExecution/requestApproval") {
      if (
        params.additionalPermissions != null ||
        params.networkApprovalContext != null ||
        params.proposedNetworkPolicyAmendments != null
      ) {
        interaction.resolve({ decision: "decline" });
        return;
      }
      const decision = await askApproval(
        "A Broker-managed worker requests command approval.",
        commandDetail(params),
        elicit,
      );
      interaction.resolve({
        decision: decision === "approve" ? "accept" : decision,
      });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      if (interaction.access !== "workspace-write" || params.grantRoot != null) {
        interaction.resolve({ decision: "decline" });
        return;
      }
      const decision = await askApproval(
        "A Broker-managed worker requests file-change approval.",
        fileDetail(params),
        elicit,
      );
      interaction.resolve({
        decision: decision === "approve" ? "accept" : decision,
      });
      return;
    }
    if (method === "execCommandApproval") {
      const decision = await askApproval(
        "A Broker-managed worker requests command approval.",
        commandDetail(params),
        elicit,
      );
      interaction.resolve({
        decision:
          decision === "approve"
            ? "approved"
            : decision === "cancel"
              ? "abort"
              : { denied: { rejection: "Declined by the Broker host" } },
      });
      return;
    }
    if (method === "applyPatchApproval") {
      if (interaction.access !== "workspace-write") {
        interaction.resolve({
          decision: { denied: { rejection: "Route is read-only" } },
        });
        return;
      }
      const decision = await askApproval(
        "A Broker-managed worker requests file-change approval.",
        fileDetail(params),
        elicit,
      );
      interaction.resolve({
        decision:
          decision === "approve"
            ? "approved"
            : decision === "cancel"
              ? "abort"
              : { denied: { rejection: "Declined by the Broker host" } },
      });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      interaction.resolve(await answerUserInput(params, elicit));
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      if (!elicit || params.mode !== "form") {
        interaction.resolve({ action: "decline", content: null, _meta: null });
        return;
      }
      const result = await elicit({
        mode: "form",
        message:
          typeof params.message === "string"
            ? truncate(params.message)
            : "A worker tool requests non-secret input.",
        requestedSchema: isRecord(params.requestedSchema)
          ? params.requestedSchema
          : { type: "object", properties: {} },
      });
      if (isRecord(result)) {
        interaction.resolve({
          action:
            result.action === "accept" ||
            result.action === "decline" ||
            result.action === "cancel"
              ? result.action
              : "cancel",
          content: isRecord(result.content) ? result.content : null,
          _meta: null,
        });
      } else {
        interaction.resolve({ action: "cancel", content: null, _meta: null });
      }
      return;
    }
    if (method === "item/permissions/requestApproval") {
      interaction.reject(
        new BrokerError(
          "permission_expansion_denied",
          "Broker workers cannot expand beyond the configured access boundary",
        ),
      );
      return;
    }
    interaction.reject(
      new BrokerError(
        "unsupported_interaction",
        `Broker cannot service App Server request ${method}`,
      ),
    );
  } catch (error) {
    interaction.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
