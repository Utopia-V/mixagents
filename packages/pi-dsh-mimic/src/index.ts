import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  BOOTSTRAP_TOOL_NAMES,
  EDITOR_DESCRIPTION,
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_PERSONA,
  STATE_ENTRY_TYPE,
  TARGET_MODEL_ID,
  TARGET_PROVIDERS,
} from "./constants.js";
import { executeEditor, type EditorArgs } from "./editor.js";
import {
  isJsonObject,
  keepMinimalPersona,
  makeBootstrapRequest,
} from "./protocol.js";
import {
  conversationHasStarted,
  type LiveStage,
  restoreStage,
  supportedRoute,
} from "./session-stage.js";

const STATUS_ID = "pi-dsh-mimic";

export default function piDshAnchor(api: ExtensionAPI): void {
  const sessions = new Map<string, LiveStage>();
  let editorAvailable = false;

  const sessionKey = (context: ExtensionContext): string => context.sessionManager.getSessionId();

  const exposeEditor = (): void => {
    if (editorAvailable) return;
    api.registerTool({
      name: "str_replace_editor",
      description: EDITOR_DESCRIPTION,
      parameters: Type.Object({
        command: StringEnum(["view", "create", "str_replace", "insert"] as const),
        path: Type.String(),
        file_text: Type.Optional(Type.String()),
        insert_line: Type.Optional(Type.Integer()),
        new_str: Type.Optional(Type.String()),
        old_str: Type.Optional(Type.String()),
        view_range: Type.Optional(Type.Array(Type.Integer())),
      }),
      label: "str_replace_editor",
      async execute(_callId, input) {
        const args = input as EditorArgs;
        return {
          content: [{ type: "text", text: executeEditor(args) }],
          details: { command: args.command, path: args.path },
        };
      },
    });
    editorAvailable = true;
  };

  const showStage = (context: ExtensionContext, stage?: LiveStage): void => {
    if (!context.hasUI) return;
    context.ui.setStatus(
      STATUS_ID,
      stage?.stage === "bootstrap" ? "V4 one-shot: bash/editor" : undefined,
    );
  };

  const saveStage = (stage: LiveStage): void => {
    api.appendEntry(STATE_ENTRY_TYPE, {
      schema: stage.schema,
      route: stage.route,
      stage: stage.stage,
    });
  };

  const locateStage = (context: ExtensionContext, create: boolean): LiveStage | undefined => {
    const route = supportedRoute(context.model);
    if (route === undefined) return undefined;

    const key = sessionKey(context);
    const cached = sessions.get(key);
    if (cached?.route === route) return cached;

    const branch = context.sessionManager.getBranch();
    const restored = restoreStage(branch, route);
    if (restored !== undefined) {
      sessions.set(key, restored);
      return restored;
    }
    if (!create || conversationHasStarted(branch)) return undefined;

    const stage: LiveStage = {
      schema: 1,
      route,
      stage: "bootstrap",
      requestIssued: false,
    };
    sessions.set(key, stage);
    saveStage(stage);
    return stage;
  };

  const enterExecution = (context: ExtensionContext, stage: LiveStage): void => {
    if (stage.stage === "execute") return;
    stage.stage = "execute";
    stage.requestIssued = false;
    saveStage(stage);
    showStage(context, stage);
  };

  const reloadSession = (context: ExtensionContext): void => {
    sessions.delete(sessionKey(context));
    const stage = locateStage(context, false);
    if (stage !== undefined) exposeEditor();
    showStage(context, stage);
  };

  api.on("session_start", (_event, context) => reloadSession(context));
  api.on("session_tree", (_event, context) => reloadSession(context));
  api.on("session_shutdown", (_event, context) => {
    sessions.delete(sessionKey(context));
    showStage(context);
  });

  api.on("model_select", (_event, context) => {
    const stage = locateStage(context, false);
    if (stage !== undefined) exposeEditor();
    showStage(context, stage);
  });

  api.on("input", (event, context) => {
    if (event.source === "extension" || supportedRoute(context.model) === undefined) return;
    const stage = locateStage(context, true);
    if (stage !== undefined) exposeEditor();
    showStage(context, stage);
  });

  api.on("before_agent_start", (event, context) => {
    const stage = locateStage(context, false);
    if (stage === undefined) {
      showStage(context);
      return;
    }
    exposeEditor();
    showStage(context, stage);
    if (event.systemPrompt !== MINIMAL_PERSONA) return { systemPrompt: MINIMAL_PERSONA };
  });

  api.on("before_provider_request", (event, context) => {
    const stage = locateStage(context, false);
    if (stage === undefined || !isJsonObject(event.payload)) return;
    exposeEditor();

    if (stage.stage === "bootstrap") {
      stage.requestIssued = true;
      return makeBootstrapRequest(event.payload);
    }
    return keepMinimalPersona(event.payload);
  });

  api.on("message_end", (event, context) => {
    const stage = locateStage(context, false);
    if (stage?.stage !== "bootstrap" || !stage.requestIssued) return;
    if (event.message.role !== "assistant"
      || event.message.stopReason === "error"
      || event.message.stopReason === "aborted") return;
    enterExecution(context, stage);
  });

  api.on("tool_call", (_event, context) => {
    const stage = locateStage(context, false);
    if (stage?.stage === "bootstrap" && stage.requestIssued) enterExecution(context, stage);
  });
}

export {
  BOOTSTRAP_TOOL_NAMES,
  EDITOR_DESCRIPTION,
  MINIMAL_BASH_DESCRIPTION,
  MINIMAL_PERSONA,
  STATE_ENTRY_TYPE,
  TARGET_MODEL_ID,
  TARGET_PROVIDERS,
};
