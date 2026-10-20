import { parse, type Node } from "acorn";
import { workflowPrelude } from "./prelude.ts";

/** Parse module syntax without evaluating host JavaScript or permitting module loading. */
export function workflowCode(source: string, argsJson: string, maxAgentCalls: number): string {
  const module = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let defaultName: string | undefined;
  let metaName: string | undefined;
  // Source-local identifiers cannot collide with the private adapter bindings.
  let prefix = "__workflow";
  while (source.includes(prefix)) prefix += "_";

  const visit = (node: Node): void => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression" || node.type === "ExportAllDeclaration") {
      throw new Error("Workflow imports are not allowed");
    }
    if (node.type === "MetaProperty" && source.slice(node.start, node.end).startsWith("import")) {
      edits.push({ start: node.start, end: node.end, text: "Object.freeze({})" });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === "string") visit(item);
      } else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
        visit(value as Node);
      }
    }
  };
  visit(module);
  for (const statement of module.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      const named = (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id;
      defaultName = named ? named.name : `${prefix}Default`;
      edits.push({ start: statement.start, end: declaration.start, text: named ? "" : `const ${defaultName} = ` });
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.source) throw new Error("Workflow imports are not allowed");
      if (statement.declaration) {
        edits.push({ start: statement.start, end: statement.declaration.start, text: "" });
        if (statement.declaration.type === "VariableDeclaration") {
          for (const declaration of statement.declaration.declarations) {
            if (declaration.id.type === "Identifier" && declaration.id.name === "meta") metaName = "meta";
          }
        }
      } else {
        edits.push({ start: statement.start, end: statement.end, text: "" });
        for (const specifier of statement.specifiers) {
          const exported = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value;
          if (specifier.local.type !== "Identifier") throw new Error("Invalid workflow export");
          if (exported === "default") defaultName = specifier.local.name;
          if (exported === "meta") metaName = specifier.local.name;
        }
      }
    }
  }
  if (!defaultName) throw new TypeError("Workflow must export a default async function");
  let body = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  const moduleBody = `${body}\n;return { default: ${defaultName}, hasMeta: ${metaName !== undefined}, meta: ${metaName ?? "undefined"} };`;
  return `${workflowPrelude(argsJson, maxAgentCalls)}
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const workflowModule = await new AsyncFunction("Date", "Math", ${JSON.stringify('"use strict";\n' + moduleBody)})(Date, Math);
    if (workflowModule.hasMeta) await bridge({ operation: "meta", value: workflowModule.meta ?? null });
    if (typeof workflowModule.default !== "function") throw new TypeError("Workflow must export a default async function");
    let result;
    try { result = await workflowModule.default(args, phase, agent, parallel, pipeline, log, followUp); }
    finally { await flush(); }
    if (pendingAgents > 0) throw new Error("Workflow returned before " + pendingAgents + " agent call" + (pendingAgents === 1 ? "" : "s") + " settled; await every agent() call");
    await flush();
    await bridge({ operation: "result", value: {
      hasMeta: workflowModule.hasMeta,
      metaUndefined: workflowModule.hasMeta && workflowModule.meta === undefined,
      resultUndefined: result === undefined,
      ...(workflowModule.meta === undefined ? {} : { meta: workflowModule.meta }),
      ...(result === undefined ? {} : { result }),
    } });
  `;
}
